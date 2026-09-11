-- Rollback of 20260911130000_stock_warm_start_rpc.sql. Drops the loader RPC.
-- Chains it has already inserted are real orders and are not touched; remove
-- them by hand if a load has to be undone (notes start with
-- 'Warm start from s.r.o. list').
drop function if exists public.hub_warm_start_po_chain(jsonb);
