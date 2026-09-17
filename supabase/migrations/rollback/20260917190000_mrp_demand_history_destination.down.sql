-- Rollback for 20260917190000_mrp_demand_history_destination.sql
--
-- Dropping this loses the destination attribution for 887 factory rows. It is rebuildable from
-- invoice_line_items.sales_person in the Manufacturing Report project, but only if that mapping is
-- remembered, so read the forward migration before deciding this is what you want.
drop index if exists public.idx_mrp_demand_history_destination;
alter table public.mrp_demand_history drop column if exists destination_org;
