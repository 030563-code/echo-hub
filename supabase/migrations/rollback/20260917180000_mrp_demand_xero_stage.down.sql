-- Rollback for 20260917180000_mrp_demand_xero_stage.sql
--
-- Staging only: the rows that mattered were merged into mrp_demand_history under
-- source = 'xero_invoice_backfill' and are not lost with this. The unmerged remainder is the
-- unmapped tail, which would have to be re-pulled by rerunning n8n workflow PB2yeP5Z3oiE4pyk.
drop policy if exists "hub: read mrp_demand_xero_stage" on public.mrp_demand_xero_stage;
drop index if exists public.idx_mrp_demand_xero_stage_org_month;
drop table if exists public.mrp_demand_xero_stage;
