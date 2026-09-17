-- Reverse of 20260917140000_japan_products.sql.
--
-- Removing the po_product_catalog rows makes Japan unorderable again and stops
-- its bill of materials exploding, so do this only if Japan is being backed out
-- entirely. product_depot_mapping and mrp_bom_map are NOT touched here: they
-- predate this migration and were not created by it.
delete from public.po_product_catalog where sku in ('EBH10JAPSK', 'EBH9JAPSK');
delete from public.product_code_master where internal_sku in ('EBH10JAP', 'EBH9JAP');
