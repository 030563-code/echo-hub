-- EB-GROUP holds stock after all, transiently. Restores what 20260917240000 removed.
--
-- Dean, 17 Sep 2026, correcting me twice in a row: first "group never holds the stock it is merely
-- an intercompany buffer", then "no no group should still be a stock holding org it will just
-- appear and then disappear out of the stock".
--
-- 🔴 The distinction matters and I got it wrong in both directions. Group is a TRANSIT buffer:
-- barriers land in its stock and leave again as they pass from the factory to a region. So its
-- level is usually at or near zero, and that is the normal resting state of a fast-flowing buffer,
-- NOT evidence that it holds nothing. I read 11 zeroes out of 13 rows as proof of absence. It was
-- proof of throughput.
--
-- Consequence for anything built on this: a near-zero on-hand is EXPECTED for EB-GROUP and must
-- not be read as a stockout. A classic DDMRP reorder point on a pass-through node would sit
-- permanently in the red for the same reason, so whether Group should carry a BUFFER is a separate
-- question from whether it should carry a stock LEVEL. It carries a level.
--
-- Both migrations are kept rather than the removal being edited away, because the reasoning in
-- 20260917240000 is what a future reader will otherwise repeat: near-zero rows look like an empty
-- feed and are not.
delete from public.product_depot_mapping where depot_code = 'EB-GROUP';

alter table public.product_depot_mapping drop constraint if exists depot_org_consistency;
alter table public.product_depot_mapping drop constraint if exists product_depot_mapping_depot_code_check;
alter table public.product_depot_mapping drop constraint if exists product_depot_mapping_xero_org_check;

alter table public.product_depot_mapping
  add constraint product_depot_mapping_depot_code_check
  check (depot_code in ('US-BAL', 'US-SBD', 'CA-HAM', 'EB-SRO', 'GB-BSE', 'EU-FR', 'EB-GROUP', 'AU-SYD'));

alter table public.product_depot_mapping
  add constraint product_depot_mapping_xero_org_check
  check (xero_org in ('USA', 'CANADA', 'SLOVAKIA', 'UK', 'FRANCE', 'GROUP', 'AUSTRALIA'));

alter table public.product_depot_mapping
  add constraint depot_org_consistency
  check (
       (depot_code in ('US-BAL', 'US-SBD') and xero_org = 'USA')
    or (depot_code = 'CA-HAM' and xero_org = 'CANADA')
    or (depot_code = 'EB-SRO' and xero_org = 'SLOVAKIA')
    or (depot_code = 'GB-BSE' and xero_org = 'UK')
    or (depot_code = 'EU-FR'  and xero_org = 'FRANCE')
    or (depot_code = 'EB-GROUP' and xero_org = 'GROUP')
    or (depot_code = 'AU-SYD' and xero_org = 'AUSTRALIA')
  );

insert into public.product_depot_mapping
  (hubspot_sku_code, depot_code, xero_org, xero_item_code, xero_item_description, product_family, is_active)
select m.internal_sku, 'EB-GROUP', 'GROUP', trim(m.code_grp), m.product_name, m.product_family, true
from public.product_code_master m
where m.is_active
  and nullif(trim(m.code_grp), '') is not null
  and m.internal_sku <> 'DELINFO'
  and not exists (
    select 1 from public.product_depot_mapping p
    where p.depot_code = 'EB-GROUP' and lower(p.xero_item_code) = lower(trim(m.code_grp))
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

select public.hub_sync_xero_stock_to_warehouse();

do $$
declare n int;
begin
  select count(*) into n from public.product_depot_mapping where depot_code = 'EB-GROUP';
  if n = 0 then raise exception 'EB-GROUP mapping rows were not restored'; end if;
end $$;
