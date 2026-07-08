-- ============================================================================
-- Echo Barrier Hub — service-role batch upsert for warehouse_stock_levels
-- Target: ops korylyniwsqtsvzuzydg (SHARED). PURELY ADDITIVE (new function only).
--
-- Used by the n8n "Unleashed → Hub Stock Sync" (and reusable by any stock feed):
-- it upserts a batch of stock rows in one call, keyed on the existing
-- UNIQUE (warehouse_code, sku). Each element of `rows` =
--   { warehouse_code, sku, product_name?, quantity_on_hand }
-- product_name is never wiped (COALESCE keeps the prior value when null).
--
-- service_role ONLY (the credentialed sync) — anon/authenticated revoked, so it
-- doesn't show up as a public-RPC advisor finding. The SKU-type split (Unleashed
-- vs ONIX/Bamida) is enforced UPSTREAM in the n8n sync, not here — this function
-- writes whatever rows it is given.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.hub_upsert_warehouse_stock(rows jsonb)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  n integer;
BEGIN
  WITH input AS (
    SELECT
      (r->>'warehouse_code')::text      AS warehouse_code,
      (r->>'sku')::text                 AS sku,
      NULLIF(r->>'product_name','')     AS product_name,
      (r->>'quantity_on_hand')::integer AS quantity_on_hand
    FROM jsonb_array_elements(rows) AS r
    WHERE r->>'warehouse_code' IS NOT NULL
      AND r->>'sku' IS NOT NULL
      AND r->>'quantity_on_hand' IS NOT NULL
  ),
  upserted AS (
    INSERT INTO public.warehouse_stock_levels
      (warehouse_code, sku, product_name, quantity_on_hand, last_counted_at, updated_at)
    SELECT warehouse_code, sku, product_name, quantity_on_hand, now(), now() FROM input
    ON CONFLICT (warehouse_code, sku) DO UPDATE
      SET quantity_on_hand = EXCLUDED.quantity_on_hand,
          product_name     = COALESCE(EXCLUDED.product_name, public.warehouse_stock_levels.product_name),
          last_counted_at  = now(),
          updated_at       = now()
    RETURNING 1
  )
  SELECT count(*) INTO n FROM upserted;
  RETURN n;
END;
$$;

REVOKE ALL ON FUNCTION public.hub_upsert_warehouse_stock(jsonb) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.hub_upsert_warehouse_stock(jsonb) TO service_role;
