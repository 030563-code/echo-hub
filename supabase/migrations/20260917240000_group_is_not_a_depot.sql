-- EB-GROUP is not a depot. It never holds stock.
--
-- Dean, 17 Sep 2026: "group never holds the stock it is merely an intercompany buffer."
--
-- I had given Group a warehouse code and synced its Xero item ledger into it a few hours earlier,
-- in migration 20260917210000. The data agreed with him and I should have read it: of the 13 rows
-- written, 11 were zero and the other two were 5 units of EU3.5 and 2 bungies, which is residue in
-- an item ledger rather than a shelf. Group owns barriers contractually as they pass from the
-- factory to a region; it never warehouses them.
--
-- 🔴 Group's DEMAND stays and matters. Its 20,026 H9 units in the last twelve months are real
-- intercompany flow and they are the factory's order book. What goes is the pretence that Group
-- has somewhere to put them. An organisation with demand and no stock is exactly what the engine's
-- no_stock_feed flag is for: it computes an ADU, which is useful, and never raises a reorder of
-- its own, which is correct.
--
-- Group's Xero item ledger is still captured in xero_stock_snapshot, where it is a useful record
-- of group-owned material sitting at the factory (17,777 units of grommets, rivets, webbing and
-- Gortex). It simply no longer pretends to be finished goods on a shelf.
delete from public.warehouse_stock_levels where warehouse_code = 'EB-GROUP';
delete from public.product_depot_mapping where depot_code = 'EB-GROUP';

alter table public.product_depot_mapping drop constraint if exists depot_org_consistency;
alter table public.product_depot_mapping drop constraint if exists product_depot_mapping_depot_code_check;
alter table public.product_depot_mapping drop constraint if exists product_depot_mapping_xero_org_check;

alter table public.product_depot_mapping
  add constraint product_depot_mapping_depot_code_check
  check (depot_code in ('US-BAL', 'US-SBD', 'CA-HAM', 'EB-SRO', 'GB-BSE', 'EU-FR', 'AU-SYD'));

alter table public.product_depot_mapping
  add constraint product_depot_mapping_xero_org_check
  check (xero_org in ('USA', 'CANADA', 'SLOVAKIA', 'UK', 'FRANCE', 'AUSTRALIA'));

alter table public.product_depot_mapping
  add constraint depot_org_consistency
  check (
       (depot_code in ('US-BAL', 'US-SBD') and xero_org = 'USA')
    or (depot_code = 'CA-HAM' and xero_org = 'CANADA')
    or (depot_code = 'EB-SRO' and xero_org = 'SLOVAKIA')
    or (depot_code = 'GB-BSE' and xero_org = 'UK')
    or (depot_code = 'EU-FR'  and xero_org = 'FRANCE')
    or (depot_code = 'AU-SYD' and xero_org = 'AUSTRALIA')
  );

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
    -- GROUP is absent on purpose: it is an intercompany buffer, not a warehouse.
    where l.xero_org in ('UK', 'FRANCE', 'AUSTRALIA')
    group by m.depot_code, m.hubspot_sku_code
  ),
  written as (
    insert into public.warehouse_stock_levels
      (warehouse_code, sku, quantity_on_hand, source, source_org, source_item_code, source_synced_at, updated_at)
    select w.depot_code, w.sku, w.qty::int, 'xero_sync', w.org, w.codes, now(), now()
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

do $$
begin
  if exists (select 1 from public.warehouse_stock_levels where warehouse_code = 'EB-GROUP') then
    raise exception 'EB-GROUP still has stock rows';
  end if;
  if exists (select 1 from public.product_depot_mapping where depot_code = 'EB-GROUP') then
    raise exception 'EB-GROUP still has depot mapping rows';
  end if;
end $$;
