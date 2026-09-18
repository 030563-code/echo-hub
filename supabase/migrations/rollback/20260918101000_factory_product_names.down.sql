-- Undo 20260918101000_factory_product_names.sql. Nothing is lost; the factory's
-- product table falls back to printing the SKU, which is the thing the e2e suite
-- refuses.

alter policy "picklist readable by authenticated" on public.po_product_catalog
  using ((select public.is_internal()));
