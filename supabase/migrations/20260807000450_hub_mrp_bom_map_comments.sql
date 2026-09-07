-- ============================================================================
-- MRP Task 5 (corrective): mrp_bom_map hardening amendments.
--   * last_seen_week — staleness persisted in the table (was console-only
--     in the seed script).
--   * verified / table comments — pin the engine contract in the schema.
-- ============================================================================
alter table public.mrp_bom_map add column last_seen_week date;

-- Backfill: every current row was seeded from the 2026-07-27 snapshot (the
-- latest week for all 22 models at seed time). scripts/seed-bom-map.ts
-- maintains this per-model from now on; a row whose component drops out of
-- the latest BOM keeps its old week and thereby surfaces as stale (rows are
-- never auto-deleted).
update public.mrp_bom_map set last_seen_week = date '2026-07-27';

comment on column public.mrp_bom_map.verified is
  'Engine contract: max_buildable trusts ONLY verified=true rows. Transcribe the Kamil worksheet by component_code across ALL SKU aliases of a model. Worksheet n/a => set bamida_item_name null + verified=true (confirmed not a Bamida-stocked material). A verified bamida_item_name that no longer joins bamida_material_stock.item_name must surface as an engine warning, never a silent drop.';

comment on column public.mrp_bom_map.last_seen_week is
  'week_start_date of the latest mfg BOM snapshot that still contained this component (maintained by scripts/seed-bom-map.ts). A row lagging max(last_seen_week) is stale — its component dropped from the BOM; staleness is persisted here rather than console-logged, and rows are never auto-deleted.';

comment on table public.mrp_bom_map is
  'Finished-SKU x component -> qty_per map feeding max_buildable = MIN(bamida available_quantity / qty_per) over verified rows. Seeded by scripts/seed-bom-map.ts (idempotent; preserves human-set bamida_item_name / verified). Re-seed cadence: wire the script into the weekly BOM-sync n8n workflow; staleness is persisted in last_seen_week, not console logs (flagged for Task 10).';
