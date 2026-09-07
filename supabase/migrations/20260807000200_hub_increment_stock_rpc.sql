-- ============================================================================
-- Echo Barrier Hub — increment_stock RPC (MRP Task 3)
-- Target: ops korylyniwsqtsvzuzydg (SHARED). PURELY ADDITIVE (new function only).
--
-- PO receipts (recordReceipt) are the ONE automatic writer of depot stock: each
-- received batch calls this per (warehouse, sku) delta. Upsert keyed on the
-- EXISTING UNIQUE (warehouse_code, sku) — warehouse_stock_levels_warehouse_code_sku_key,
-- verified live 2026-08-07, so no constraint is added here.
--
-- p_delta is integer, matching quantity_on_hand (integer NOT NULL) — receipt
-- qtys are zod-validated positive ints, so no numeric/rounding ambiguity.
-- last_counted_at is set only on INSERT (row genesis): an increment is a
-- receipt, not a stocktake, so an existing row keeps its last true count
-- timestamp (deliberate divergence from hub_upsert_warehouse_stock, which IS
-- a count feed and bumps it).
--
-- service_role ONLY (called via the admin client server-side) — anon/
-- authenticated revoked, matching hub_upsert_warehouse_stock's convention.
-- ============================================================================

create or replace function public.increment_stock(p_warehouse text, p_sku text, p_delta integer)
returns void
language sql
security definer
set search_path = public
as $$
  insert into warehouse_stock_levels (warehouse_code, sku, quantity_on_hand, last_counted_at, updated_at)
  values (p_warehouse, p_sku, p_delta, now(), now())
  on conflict (warehouse_code, sku) do update
    set quantity_on_hand = warehouse_stock_levels.quantity_on_hand + p_delta,
        updated_at = now();
$$;

revoke all on function public.increment_stock(text, text, integer) from public, anon, authenticated;
grant execute on function public.increment_stock(text, text, integer) to service_role;
