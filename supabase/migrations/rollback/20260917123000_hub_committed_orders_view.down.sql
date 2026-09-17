-- Reverse of 20260917123000_hub_committed_orders_view.sql. The view holds no
-- data of its own, so dropping it loses nothing; the Xero-sourced
-- eb_operations.committed_orders is untouched either way.
drop view if exists public.hub_committed_orders;
