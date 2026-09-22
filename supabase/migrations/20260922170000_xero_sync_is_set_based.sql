-- Reconcile a whole Xero organisation in four statements instead of one per item.
--
-- The first live run of the hourly sync refreshed six organisations and lost the seventh:
--
--   UK was not written: the reconcile refused it, HTTP 500: canceling statement due to
--   statement timeout
--
-- The function looped over the items and ran an UPDATE for each one, so its cost grew with the
-- catalogue. Six organisations fitted inside PostgREST's statement timeout and the UK did not.
-- The fix is not a longer timeout, which only moves the cliff; it is to stop doing a round trip
-- per item. Everything below is set-based, so the work is the same shape whether an organisation
-- has eight items or eight hundred.
--
-- Nothing about the RULES changes. Codes still match case-insensitively, a person's row is still
-- never switched off, an empty list is still refused, and an organisation whose items all fall
-- outside the depot rules still retires nothing. Only the number of statements changes.

create or replace function public.sync_xero_items(p_xero_org text, p_items jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  n_created int := 0;
  n_updated int := 0;
  n_archived int := 0;
  n_flagged int := 0;
  n_recognised int := 0;
  v_unmapped text[] := '{}';
begin
  if p_xero_org is null or jsonb_typeof(p_items) <> 'array' then
    raise exception 'sync_xero_items needs an organisation and an array of items';
  end if;

  -- An empty array is refused rather than obeyed. A tenant that answers with nothing is almost
  -- always a broken call, and obeying it would retire every synced row that organisation has.
  if jsonb_array_length(p_items) = 0 then
    raise exception 'sync_xero_items refused an empty item list for %: that would retire every synced row', p_xero_org;
  end if;

  -- The incoming items, once, in a form every statement below can join to. Held in a temporary
  -- table rather than repeated as a CTE so the JSON is expanded and the depot rules are applied
  -- one time instead of four. ON COMMIT DROP: PostgREST gives each request its own transaction.
  create temporary table _xero_incoming on commit drop as
  select
    distinct on (upper(s.code))
    s.code,
    public.depot_for_xero_item(p_xero_org, s.code) as depot,
    s.descr,
    s.item_id,
    s.unit_price,
    s.sales_account,
    s.purchase_account
  from (
    select
      nullif(btrim(e->>'Code'), '') as code,
      coalesce(nullif(btrim(e->>'Name'), ''), nullif(btrim(e->>'Description'), '')) as descr,
      nullif(e->>'ItemID', '')::uuid as item_id,
      (e#>>'{SalesDetails,UnitPrice}')::numeric as unit_price,
      e#>>'{SalesDetails,AccountCode}' as sales_account,
      e#>>'{PurchaseDetails,AccountCode}' as purchase_account
    from jsonb_array_elements(p_items) e
  ) s
  where s.code is not null;

  create index on _xero_incoming (depot, upper(code));

  select coalesce(array_agg(code order by code), '{}') into v_unmapped
  from _xero_incoming where depot is null;

  select count(*) into n_recognised from _xero_incoming where depot is not null;

  -- An organisation whose items ALL fall outside the depot rules retires nothing. Otherwise a
  -- rule table edited badly would quietly switch off a whole catalogue.
  if n_recognised = 0 then
    return jsonb_build_object(
      'xero_org', p_xero_org, 'received', jsonb_array_length(p_items),
      'created', 0, 'updated', 0, 'retired', 0, 'flagged', 0,
      'unmapped', to_jsonb(v_unmapped),
      'warning', 'no item matched a depot rule, so nothing was retired'
    );
  end if;

  -- 1. Refresh Xero's own fields on every row for these items. There can be more than one row per
  --    item: two HubSpot SKUs may point at a single Xero item, and both want the current name.
  update public.product_depot_mapping m set
    xero_item_id = coalesce(i.item_id, m.xero_item_id),
    xero_item_description = coalesce(i.descr, m.xero_item_description),
    xero_unit_price = coalesce(i.unit_price, m.xero_unit_price),
    xero_sales_account_code = coalesce(i.sales_account, m.xero_sales_account_code),
    xero_purchase_account_code = coalesce(i.purchase_account, m.xero_purchase_account_code),
    xero_is_archived = false,
    last_seen_in_xero_at = now(),
    updated_at = now()
  from _xero_incoming i
  where upper(m.xero_org) = upper(p_xero_org)
    and m.depot_code = i.depot
    and upper(btrim(m.xero_item_code)) = upper(i.code);
  get diagnostics n_updated = row_count;

  -- 2. An item nobody has mapped. Recorded so it can be ordered, with no HubSpot SKU and no
  --    product family, both of which are a person's to fill in later.
  insert into public.product_depot_mapping (
    hubspot_sku_code, depot_code, xero_org, xero_item_code, xero_item_description,
    is_active, source, xero_item_id, xero_unit_price, xero_sales_account_code,
    xero_purchase_account_code, xero_is_archived, last_seen_in_xero_at
  )
  select
    null, i.depot, upper(p_xero_org), i.code, i.descr,
    true, 'xero', i.item_id, i.unit_price, i.sales_account, i.purchase_account, false, now()
  from _xero_incoming i
  where i.depot is not null
    and not exists (
      select 1 from public.product_depot_mapping m
      where upper(m.xero_org) = upper(p_xero_org)
        and m.depot_code = i.depot
        and upper(btrim(m.xero_item_code)) = upper(i.code)
    )
  on conflict (xero_org, xero_item_code, depot_code) where hubspot_sku_code is null do nothing;
  get diagnostics n_created = row_count;

  -- 3. An item that has left Xero, on a row the sync created. Switched off, because it owns it.
  update public.product_depot_mapping m set
    xero_is_archived = true, is_active = false, updated_at = now()
  where upper(m.xero_org) = upper(p_xero_org)
    and m.source = 'xero'
    and (m.is_active or not m.xero_is_archived)
    and not exists (
      select 1 from _xero_incoming i
      where i.depot = m.depot_code and upper(i.code) = upper(btrim(m.xero_item_code))
    );
  get diagnostics n_archived = row_count;

  -- 4. An item that has left Xero, on a row a PERSON made. Flagged and left alone, because
  --    switching off somebody's mapping is their call. This is the number that should make
  --    someone look: such a product is still orderable in the Hub, and its line would be dropped
  --    on the way into Xero.
  update public.product_depot_mapping m set
    xero_is_archived = true, updated_at = now()
  where upper(m.xero_org) = upper(p_xero_org)
    and m.source = 'manual'
    and not m.xero_is_archived
    and not exists (
      select 1 from _xero_incoming i
      where i.depot = m.depot_code and upper(i.code) = upper(btrim(m.xero_item_code))
    );
  get diagnostics n_flagged = row_count;

  return jsonb_build_object(
    'xero_org', p_xero_org,
    'received', jsonb_array_length(p_items),
    'recognised', n_recognised,
    'created', n_created,
    'updated', n_updated,
    'retired', n_archived,
    'flagged', n_flagged,
    -- The standing total, not just this run's change. `flagged` is a delta and reads 0 on every
    -- run after the first, which would make a real problem look like it had gone away.
    'flagged_total', (
      select count(*) from public.product_depot_mapping m
      where upper(m.xero_org) = upper(p_xero_org) and m.source = 'manual' and m.xero_is_archived
    ),
    'unmapped', to_jsonb(v_unmapped)
  );
end $$;

comment on function public.sync_xero_items(text, jsonb) is
  'Reconcile one Xero organisation''s /Items response into product_depot_mapping, set-based so the cost does not grow with the catalogue. Creates a row for an item nobody has mapped, refreshes Xero''s own fields, switches off only rows it created itself, and flags a hand-made row whose item has left Xero. Refuses an empty list.';

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
