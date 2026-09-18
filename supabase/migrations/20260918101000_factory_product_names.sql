-- The factory's product table names the product, not the SKU.
--
-- EBH9NA is our database code and means nothing to a factory; the e2e suite
-- asserts no SKU ever reaches their screen. The name lives in po_product_catalog,
-- which was readable by staff only. The table is a picklist (sku, name, family,
-- region, model code) and carries no price, so the factory account may read it.

alter policy "picklist readable by authenticated" on public.po_product_catalog
  using ((select public.is_internal()) or (select public.has_capability('factory.view')));

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'po_product_catalog'
      and cmd = 'SELECT' and qual like '%factory.view%'
  ) then
    raise exception 'factory_product_names: the factory still cannot read po_product_catalog';
  end if;
end $$;
