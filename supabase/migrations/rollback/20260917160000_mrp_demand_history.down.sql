-- Rollback for 20260917160000_mrp_demand_history.sql
--
-- The table is additive: nothing reads it yet and mrp_demand_events was not
-- touched by the forward migration, so dropping it loses only the loaded
-- history, which can be rebuilt from the four sources it was read from
-- (the MCS mirror, the s.r.o. sales ledger and the Xero tracking series).
drop policy if exists "hub: read mrp_demand_history" on public.mrp_demand_history;

drop index if exists public.idx_mrp_demand_history_channel;
drop index if exists public.idx_mrp_demand_history_model_date;
drop index if exists public.idx_mrp_demand_history_org_month;

drop table if exists public.mrp_demand_history;
