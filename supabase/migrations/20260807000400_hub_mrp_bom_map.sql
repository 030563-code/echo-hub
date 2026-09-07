-- ============================================================================
-- MRP Task 5: mrp_bom_map — finished-SKU -> Bamida raw-material map.
--
-- Feeds max_buildable(sku) = MIN(bamida available_quantity / qty_per) over the
-- SKU's mapped components. Seeded from the mfg project's bom_weekly_snapshot
-- (latest week per model_code, component_detail jsonb) by
-- scripts/seed-bom-map.ts — see that script for the model_code -> SKU join.
--
-- finished_sku uses the MRP engine's SKU vocabulary (VALID_SKUS in
-- src/app/(dashboard)/mrp/actions.ts): NA depot SKUs (joined via
-- po_product_catalog.bom_model_code, same join src/lib/bom.ts uses) plus
-- SK/SRO SKUs (1:1 name map, same vocabulary as transport/actions.ts).
-- NOTE: this is deliberately NOT product_code_master.internal_sku — that
-- vocabulary never appears in mrp_demand_events / deal line items.
--
-- bamida_item_name stays null until a human maps the component to a
-- bamida_material_stock.item_name row (Kamil worksheet:
-- docs/mrp/bamida-bom-mapping-worksheet.md). Auto-suggested matches are
-- filled conservatively with verified=false; the mapping session flips
-- verified=true. The MRP engine must only trust verified rows for
-- max_buildable; unverified/unmapped components are capacity-unknown.
--
-- Write path is service-role only (seed script / future admin UI) — no
-- authenticated write policies, matching the other mrp_* tables.
-- ============================================================================
create table public.mrp_bom_map (
  finished_sku text not null,
  component_code text not null,
  component_desc text,
  qty_per numeric not null check (qty_per > 0),
  bamida_item_name text,          -- null until mapped to bamida_material_stock.item_name
  verified boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (finished_sku, component_code)
);

alter table public.mrp_bom_map enable row level security;

create policy "hub: read mrp_bom_map"
  on public.mrp_bom_map for select to authenticated
  using (true);
