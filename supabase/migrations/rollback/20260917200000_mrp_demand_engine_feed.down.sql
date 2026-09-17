-- Rollback for 20260917200000_mrp_demand_engine_feed.sql
--
-- 🔴 The engine reads this view (src/lib/mrp/engine-data.ts). Dropping it without also reverting
-- that read leaves the nightly run with no demand at all, which will not error, it will just size
-- every buffer on nothing. Revert the code first.
drop view if exists public.mrp_demand_engine_feed;
