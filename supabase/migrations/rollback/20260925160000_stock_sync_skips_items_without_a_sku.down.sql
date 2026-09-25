-- Undo 20260925160000_stock_sync_skips_items_without_a_sku.sql.
--
-- Puts back the body from 20260922110000_stock_on_hand_floor.sql, which joins every active
-- mapping row. While product_depot_mapping holds rows with no SKU, that body makes every Xero
-- snapshot write fail (see the migration's header), so only undo this together with a fix for
-- those rows.

create or replace function public.hub_sync_xero_stock_to_warehouse()
returns table (depot text, skus int, units numeric)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  return query
  with latest as (
    select distinct on (s.xero_org, s.xero_item_code)
      s.xero_org, s.xero_item_code, s.qty_on_hand, s.snapshot_date
    from public.xero_stock_snapshot s
    order by s.xero_org, s.xero_item_code, s.snapshot_date desc
  ),
  mapped as (
    select
      m.depot_code,
      m.hubspot_sku_code as sku,
      sum(l.qty_on_hand) as qty,
      string_agg(distinct l.xero_item_code, '+' order by l.xero_item_code) as codes,
      min(m.xero_org) as org
    from latest l
    join public.product_depot_mapping m
      on m.xero_org = l.xero_org
     and lower(trim(m.xero_item_code)) = lower(trim(l.xero_item_code))
     and m.is_active
    -- GROUP is back in, and its level being at or near zero is the normal state of a transit
    -- buffer rather than a missing feed. Raw materials still never arrive here: no mapping row
    -- claims Group's 0002 to 0016 codes (grommets, rivets, webbing, Gortex), so they stay out of
    -- the finished-goods ledger where they belong.
    where l.xero_org in ('UK', 'FRANCE', 'GROUP', 'AUSTRALIA')
    group by m.depot_code, m.hubspot_sku_code
  ),
  written as (
    insert into public.warehouse_stock_levels
      (warehouse_code, sku, quantity_on_hand, source, source_org, source_item_code, source_synced_at, updated_at)
    -- Floored at zero: on hand is never negative, whatever a snapshot says.
    select w.depot_code, w.sku, greatest(0, w.qty)::int, 'xero_sync', w.org, w.codes, now(), now()
    from mapped w
    on conflict (warehouse_code, sku) do update
      set quantity_on_hand = excluded.quantity_on_hand,
          source_org = excluded.source_org,
          source_item_code = excluded.source_item_code,
          source_synced_at = excluded.source_synced_at,
          updated_at = now()
      where public.warehouse_stock_levels.source = 'xero_sync'
    returning warehouse_code, sku, quantity_on_hand
  )
  select written.warehouse_code, count(*)::int, sum(written.quantity_on_hand)::numeric
  from written
  group by written.warehouse_code;
end;
$$;

revoke all on function public.hub_sync_xero_stock_to_warehouse() from public, anon;
grant execute on function public.hub_sync_xero_stock_to_warehouse() to service_role;
