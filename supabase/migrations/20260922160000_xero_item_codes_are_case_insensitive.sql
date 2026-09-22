-- Match a Xero item code without caring about its case.
--
-- The first real run of the reconcile flagged France's HOOKS as "no longer in Xero". It is in
-- Xero, spelled Hooks. Xero itself will not let two items differ only by case, so two codes that
-- differ only by case are the same item, and comparing them byte for byte invents a problem and
-- hides the product.
--
-- 🔴 This changes what gets flagged, not what gets stored. A row keeps the code somebody typed;
-- only the comparison is case-blind. Nothing renames anything, because renaming a code that is
-- already on sent purchase orders is a different decision and not one a sync should take.

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

    -- Compared upper, stored as Xero spells it.
    seen := seen || upper(v_code);
    v_desc := coalesce(nullif(btrim(item->>'Name'), ''), nullif(btrim(item->>'Description'), ''));

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
      and upper(btrim(m.xero_item_code)) = upper(v_code);
    get diagnostics v_touched = row_count;

    if v_touched > 0 then
      n_updated := n_updated + v_touched;
    else
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

  if array_length(seen, 1) is null then
    return jsonb_build_object(
      'xero_org', p_xero_org, 'received', jsonb_array_length(p_items),
      'created', 0, 'updated', 0, 'retired', 0, 'flagged', 0,
      'unmapped', to_jsonb(unmapped),
      'warning', 'no item matched a depot rule, so nothing was retired'
    );
  end if;

  update public.product_depot_mapping m set
    xero_is_archived = true, is_active = false, updated_at = now()
  where upper(m.xero_org) = upper(p_xero_org)
    and m.source = 'xero'
    and not (upper(btrim(m.xero_item_code)) = any (seen))
    and (m.is_active or not m.xero_is_archived);
  get diagnostics n_archived = row_count;

  -- Flagged, not switched off: overruling a person's mapping is their call. This is the number
  -- that should make somebody look, because such a product is still orderable in the Hub and its
  -- line would be dropped on the way into Xero.
  update public.product_depot_mapping m set xero_is_archived = true, updated_at = now()
  where upper(m.xero_org) = upper(p_xero_org)
    and m.source = 'manual'
    and not (upper(btrim(m.xero_item_code)) = any (seen))
    and not m.xero_is_archived;
  get diagnostics n_flagged = row_count;

  -- And the other way: a hand-made row whose item is back (or was never really gone, as with a
  -- case-only difference) has its flag cleared by the refresh above, so nothing stays stale.
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

revoke all on function public.sync_xero_items(text, jsonb) from public, anon, authenticated;
grant execute on function public.sync_xero_items(text, jsonb) to service_role;

do $$
begin
  if exists (
    select 1 from information_schema.routine_privileges
    where routine_schema='public' and routine_name='sync_xero_items' and grantee in ('PUBLIC','anon','authenticated')
  ) then
    raise exception 'anon, authenticated or PUBLIC hold EXECUTE on sync_xero_items';
  end if;
end $$;
