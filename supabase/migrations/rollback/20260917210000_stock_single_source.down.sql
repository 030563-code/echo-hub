-- Rollback for 20260917210000_stock_single_source.sql
--
-- 🔴 Run the 20260917220000 rollback FIRST. That one removes the trigger and the sync function;
-- without it this rollback deletes the mapping rows the sync depends on and the next feed write
-- fails rather than quietly doing nothing.
--
-- Dropping the source column loses the record of WHICH figures were counted and which were synced.
-- The synced rows themselves survive as rows, which is the dangerous part: they become
-- indistinguishable from counted stock. Delete them rather than leave them lying:
delete from public.warehouse_stock_levels where warehouse_code in ('GB-BSE', 'EU-FR', 'EB-GROUP');

delete from public.product_depot_mapping where depot_code in ('GB-BSE', 'EU-FR', 'EB-GROUP', 'AU-SYD');

alter table public.product_depot_mapping drop constraint if exists depot_org_consistency;
alter table public.product_depot_mapping drop constraint if exists product_depot_mapping_depot_code_check;
alter table public.product_depot_mapping drop constraint if exists product_depot_mapping_xero_org_check;
alter table public.product_depot_mapping
  add constraint product_depot_mapping_depot_code_check
  check (depot_code in ('US-BAL', 'US-SBD', 'CA-HAM', 'EB-SRO'));
alter table public.product_depot_mapping
  add constraint product_depot_mapping_xero_org_check
  check (xero_org in ('USA', 'CANADA', 'SLOVAKIA'));
alter table public.product_depot_mapping
  add constraint depot_org_consistency
  check ((depot_code in ('US-BAL', 'US-SBD') and xero_org = 'USA')
      or (depot_code = 'CA-HAM' and xero_org = 'CANADA')
      or (depot_code = 'EB-SRO' and xero_org = 'SLOVAKIA'));

-- The France item codes are left in product_code_master on purpose: they are true regardless of
-- this migration, and removing them would lose a fact somebody would have to look up again.

alter table public.warehouse_stock_levels
  drop column if exists source_synced_at,
  drop column if exists source_item_code,
  drop column if exists source_org,
  drop column if exists source;
