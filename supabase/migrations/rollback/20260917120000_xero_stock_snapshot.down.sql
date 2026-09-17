-- Reverse of 20260917120000_xero_stock_snapshot.sql. Drops the table and with
-- it every row, so take a copy first if any history has accumulated.
drop policy if exists "hub: read xero_stock_snapshot" on public.xero_stock_snapshot;
drop table if exists public.xero_stock_snapshot;
