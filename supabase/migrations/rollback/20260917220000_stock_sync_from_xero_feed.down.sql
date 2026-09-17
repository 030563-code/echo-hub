-- Rollback for 20260917220000_stock_sync_from_xero_feed.sql
--
-- Run this BEFORE the 20260917210000 rollback. Removing the trigger first means the feed simply
-- stops flowing into the ledger; the UK, France and Group rows already written stay until the
-- other rollback deletes them, so nothing reads a half-updated figure in between.
drop trigger if exists xero_stock_snapshot_sync on public.xero_stock_snapshot;
drop function if exists public.trg_xero_stock_snapshot_sync();
drop function if exists public.hub_sync_xero_stock_to_warehouse();
