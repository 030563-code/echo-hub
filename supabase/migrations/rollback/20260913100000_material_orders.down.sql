-- Rollback of 20260913100000_material_orders. Drops the table and the rows in
-- it (they are Juraj's "ordered not delivered" lines, re-loadable from the
-- CSV under scripts/stock).
drop table if exists public.material_orders;
