-- Two things a smoke test of 20260922140000 found, before n8n starts calling it hourly.
--
-- 1. THE RECONCILE UNDER-REPORTED ITSELF. When an item a PERSON mapped disappears from Xero the
--    function flags the row (xero_is_archived) and deliberately leaves is_active alone, because a
--    person's decision is not the sync's to overturn. But that flip was never counted, so the run
--    answered "retired: 0" and nobody would ever learn that a mapped product had gone. A silent
--    correct action is still silent. It is counted now, as `flagged`, and that is the number worth
--    watching: it means somebody has to look.
--
-- 2. depot_for_xero_item was left executable by PUBLIC, anon and authenticated, while
--    sync_xero_items beside it was revoked. Not a leak, because the rules table it reads revokes
--    those roles and has row level security with a service-role policy only, so the call fails on
--    permissions rather than answering. But two functions in one feature disagreeing about who may
--    call them is how the next person gets the wrong idea.

create or replace function public.sync_xero_items(p_xero_org text, p_items jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  item jsonb;
  v_code text;
  v_depot text;
  v_desc text;
  v_touched int;
  n_created int := 0;
  n_updated int := 0;
  n_archived int := 0;
  n_flagged int := 0;
  unmapped text[] := '{}';
  seen text[] := '{}';
begin
  if p_xero_org is null or jsonb_typeof(p_items) <> 'array' then
    raise exception 'sync_xero_items needs an organisation and an array of items';
  end if;

  -- An empty array is refused rather than obeyed. A tenant that answers with nothing is almost
  -- always a broken call, and obeying it would switch off every product that organisation sells.
  if jsonb_array_length(p_items) = 0 then
    raise exception 'sync_xero_items refused an empty item list for %: that would retire every synced row', p_xero_org;
  end if;

  for item in select * from jsonb_array_elements(p_items) loop
    v_code := nullif(btrim(item->>'Code'), '');
    continue when v_code is null;

    v_depot := public.depot_for_xero_item(p_xero_org, v_code);
    if v_depot is null then
      unmapped := unmapped || v_code;
      continue;
    end if;

    seen := seen || v_code;
    -- Xero calls it Name on an item and Description on the sales side; take whichever it sent.
    v_desc := coalesce(nullif(btrim(item->>'Name'), ''), nullif(btrim(item->>'Description'), ''));

    -- Refresh EVERY row for this item at this depot. There can be more than one: two HubSpot SKUs
    -- may point at a single Xero item, and both of them want Xero's current name and price.
    update public.product_depot_mapping m set
      xero_item_id = coalesce((item->>'ItemID')::uuid, m.xero_item_id),
      xero_item_description = coalesce(v_desc, m.xero_item_description),
      xero_unit_price = coalesce((item#>>'{SalesDetails,UnitPrice}')::numeric, m.xero_unit_price),
      xero_sales_account_code = coalesce(item#>>'{SalesDetails,AccountCode}', m.xero_sales_account_code),
      xero_purchase_account_code = coalesce(item#>>'{PurchaseDetails,AccountCode}', m.xero_purchase_account_code),
      xero_is_archived = false,
      last_seen_in_xero_at = now(),
      updated_at = now()
    where upper(m.xero_org) = upper(p_xero_org)
      and m.depot_code = v_depot
      and btrim(m.xero_item_code) = v_code;
    get diagnostics v_touched = row_count;

    if v_touched > 0 then
      n_updated := n_updated + v_touched;
    else
      -- Nobody has mapped this item. Record it so it can be ordered, with no HubSpot SKU and no
      -- product family, both of which are a person's to fill in later.
      insert into public.product_depot_mapping (
        hubspot_sku_code, depot_code, xero_org, xero_item_code, xero_item_description,
        is_active, source, xero_item_id, xero_unit_price, xero_sales_account_code,
        xero_purchase_account_code, xero_is_archived, last_seen_in_xero_at
      ) values (
        null, v_depot, upper(p_xero_org), v_code, v_desc,
        true, 'xero', (item->>'ItemID')::uuid,
        (item#>>'{SalesDetails,UnitPrice}')::numeric,
        item#>>'{SalesDetails,AccountCode}',
        item#>>'{PurchaseDetails,AccountCode}',
        false, now()
      )
      on conflict (xero_org, xero_item_code, depot_code) where hubspot_sku_code is null do nothing;
      get diagnostics v_touched = row_count;
      n_created := n_created + v_touched;
    end if;
  end loop;

  -- 🔴 Retire nothing unless we actually recognised something. A tenant whose items ALL fall
  -- outside the depot rules would otherwise leave `seen` empty and retire every synced row, which
  -- is the same disaster as an empty response wearing a different hat.
  if array_length(seen, 1) is null then
    return jsonb_build_object(
      'xero_org', p_xero_org,
      'received', jsonb_array_length(p_items),
      'created', 0, 'updated', 0, 'retired', 0, 'flagged', 0,
      'unmapped', to_jsonb(unmapped),
      'warning', 'no item matched a depot rule, so nothing was retired'
    );
  end if;

  -- An item that has left Xero, on a row the sync created. Switched off, because the sync owns it.
  update public.product_depot_mapping m set
    xero_is_archived = true,
    is_active = false,
    updated_at = now()
  where upper(m.xero_org) = upper(p_xero_org)
    and m.source = 'xero'
    and not (btrim(m.xero_item_code) = any (seen))
    and (m.is_active or not m.xero_is_archived);
  get diagnostics n_archived = row_count;

  -- An item that has left Xero, on a row a PERSON made. Flagged and left alone, because switching
  -- off somebody's mapping is their call. `flagged` is the number that should make someone look:
  -- a product that is still orderable in the Hub and no longer exists in Xero will reach Xero as
  -- an unmapped line and be dropped from the order.
  update public.product_depot_mapping m set xero_is_archived = true, updated_at = now()
  where upper(m.xero_org) = upper(p_xero_org)
    and m.source = 'manual'
    and not (btrim(m.xero_item_code) = any (seen))
    and not m.xero_is_archived;
  get diagnostics n_flagged = row_count;

  return jsonb_build_object(
    'xero_org', p_xero_org,
    'received', jsonb_array_length(p_items),
    'created', n_created,
    'updated', n_updated,
    'retired', n_archived,
    'flagged', n_flagged,
    'unmapped', to_jsonb(unmapped)
  );
end $$;

comment on function public.sync_xero_items(text, jsonb) is
  'Reconcile one Xero organisation''s /Items response into product_depot_mapping. Creates a row for an item nobody has mapped, refreshes Xero''s own fields on every row, switches off only the rows it created itself, and FLAGS a hand-made row whose item has left Xero rather than overruling the person who made it. Refuses an empty list.';

revoke all on function public.sync_xero_items(text, jsonb) from public, anon, authenticated;
grant execute on function public.sync_xero_items(text, jsonb) to service_role;
revoke all on function public.depot_for_xero_item(text, text) from public, anon, authenticated;
grant execute on function public.depot_for_xero_item(text, text) to service_role;

do $$
begin
  if exists (
    select 1 from information_schema.routine_privileges
    where routine_schema = 'public'
      and routine_name in ('sync_xero_items', 'depot_for_xero_item')
      and grantee in ('PUBLIC', 'anon', 'authenticated')
  ) then
    raise exception 'anon, authenticated or PUBLIC still hold EXECUTE on the Xero sync functions';
  end if;

  if (select prosecdef from pg_proc where proname = 'sync_xero_items') then
    raise exception 'sync_xero_items must be SECURITY INVOKER';
  end if;
end $$;
