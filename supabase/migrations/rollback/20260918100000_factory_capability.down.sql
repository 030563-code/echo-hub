-- Undo 20260918100000_factory_capability.sql
--
-- Loses the alert memory (factory_stock_alerts) and the last_changed_at column.
-- The column is reproducible from bamida_material_stock_history; the alert
-- rows are not, so take a copy first if they matter:
--   create table public.factory_stock_alerts_backup as select * from public.factory_stock_alerts;

drop table if exists public.factory_stock_alerts;

alter policy "hub: read mrp_buffer_status_daily" on public.mrp_buffer_status_daily
  using ((select public.is_internal()));
alter policy "hub: read mrp_bom_product" on public.mrp_bom_product
  using ((select public.is_internal()));
alter policy "hub: read mrp_bom_component" on public.mrp_bom_component
  using ((select public.is_internal()));
alter policy "hub: read mrp_bom_sku_map" on public.mrp_bom_sku_map
  using ((select public.is_internal()));

drop trigger if exists trg_bamida_stock_track_change on public.bamida_material_stock;
drop function if exists public.bamida_stock_track_change();
alter table public.bamida_material_stock drop column if exists last_changed_at;
