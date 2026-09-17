-- Rollback for 20260917240000_group_is_not_a_depot.sql
--
-- 🔴 Do not run this to "restore Group's stock". Group has no stock: it is an intercompany buffer
-- and the rows this removed were an item-ledger artefact, 11 zeroes and two residual lines. This
-- rollback only exists to restore the constraint shape if something downstream turns out to depend
-- on EB-GROUP being an allowed depot code. It does NOT recreate the mapping or the stock rows,
-- because recreating a fiction is not a recovery.
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
  check ((depot_code in ('US-BAL', 'US-SBD') and xero_org = 'USA')
      or (depot_code = 'CA-HAM' and xero_org = 'CANADA')
      or (depot_code = 'EB-SRO' and xero_org = 'SLOVAKIA')
      or (depot_code = 'GB-BSE' and xero_org = 'UK')
      or (depot_code = 'EU-FR'  and xero_org = 'FRANCE')
      or (depot_code = 'EB-GROUP' and xero_org = 'GROUP')
      or (depot_code = 'AU-SYD' and xero_org = 'AUSTRALIA'));
