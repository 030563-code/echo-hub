/**
 * generate-demo-data.ts — CLI entry point for the Andy demo dataset.
 * Pure generation + file IO: no database access, no env vars.
 *
 * Usage:
 *   npx tsx scripts/demo/generate-demo-data.ts
 *
 * Writes scripts/demo/out/seed-XX-*.sql, teardown.sql, checks.sql and
 * summary.json. The orchestrator runs the SQL against the live DB — this
 * script never does.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import * as design from "./design";
import { buildDemoData } from "./generate";
import { emitSeedSql, emitTeardownSql } from "./emit-sql";

const OUT_DIR = path.join(process.cwd(), "scripts", "demo", "out");

// Must match the fixed order emitSeedSql() returns.
const BATCH_FILENAMES = [
  "seed-00-registry.sql",
  "seed-01-demand.sql",
  "seed-02-stage-weight.sql",
  "seed-03-leadtimes.sql",
  "seed-04-deals.sql",
  "seed-05-pos.sql",
  "seed-06-shipments.sql",
  "seed-07-stock.sql",
  "seed-08-profiles.sql",
];

function buildChecksSql(): string {
  return `select jsonb_pretty(jsonb_build_object(
  'row_counts', jsonb_build_object(
    'mrp_demand_events', (select count(*) from public.mrp_demand_events where source_ref like 'DEMO-%'),
    'mrp_stage_weights', (select count(*) from public.mrp_stage_weights where stage_id = 'demo_late_stage'),
    'mrp_lead_time_actuals', (select count(*) from public.mrp_lead_time_actuals where spot_id = 'DEMO'),
    'deals_registry', (select count(*) from public.deals_registry where hubspot_deal_id like 'DEMO-%'),
    'purchase_orders', (select count(*) from public.purchase_orders where po_number like 'DEMO-%'),
    'purchase_order_lines', (select count(*) from public.purchase_order_lines pol join public.purchase_orders po on po.id = pol.po_id where po.po_number like 'DEMO-%'),
    'po_line_receipts', (select count(*) from public.po_line_receipts r join public.purchase_orders po on po.id = r.po_id where po.po_number like 'DEMO-%'),
    'shipment_contents_inserted', (select count(*) from public.shipment_contents where spot_id like 'DEMO-SPOT-%'),
    'shipment_contents_flipped_delivered', (select count(*) from public.mrp_demo_seed_registry where table_name = 'shipment_contents' and op = 'update')
  ),
  'synthetic_demand_by_sku', (
    select coalesce(jsonb_object_agg(sku, total), '{}'::jsonb)
    from (
      select sku, sum(qty) as total
      from public.mrp_demand_events
      where source = 'demo_seed'
      group by sku
      order by sku
    ) t
  )
)) as demo_checks;
`;
}

function main() {
  const data = buildDemoData(design, design.TODAY);
  const batches = emitSeedSql(data);
  const teardown = emitTeardownSql(data);
  const checks = buildChecksSql();

  mkdirSync(OUT_DIR, { recursive: true });

  batches.forEach((sql, i) => {
    writeFileSync(path.join(OUT_DIR, BATCH_FILENAMES[i]), sql, "utf8");
  });
  writeFileSync(path.join(OUT_DIR, "teardown.sql"), teardown, "utf8");
  writeFileSync(path.join(OUT_DIR, "checks.sql"), checks, "utf8");

  // --- summary.json ----------------------------------------------------------
  const syntheticBySku = new Map<string, number>();
  for (const e of data.demandEvents) {
    if (e.source !== "demo_seed") continue;
    syntheticBySku.set(e.sku, (syntheticBySku.get(e.sku) ?? 0) + e.qty);
  }

  const windowStartMonth = design.DEMAND_WINDOW_START.slice(0, 7);
  const windowEndMonth = design.DEMAND_WINDOW_END.slice(0, 7);
  const realBySku = new Map<string, number>();
  for (const [sku, months] of Object.entries(design.REAL_DEMAND)) {
    let total = 0;
    for (const [monthStr, qty] of Object.entries(months)) {
      if (monthStr >= windowStartMonth && monthStr <= windowEndMonth) total += qty;
    }
    realBySku.set(sku, total);
  }

  const perSku = design.SKU_ORDER.map((sku) => ({
    sku,
    annual_2026_target: design.ANNUAL_2026[sku],
    synthetic_window_total: syntheticBySku.get(sku) ?? 0,
    real_window_total: realBySku.get(sku) ?? 0,
    combined_window_total: (syntheticBySku.get(sku) ?? 0) + (realBySku.get(sku) ?? 0),
  }));

  const summary = {
    demo_today: design.TODAY,
    batch_tag: design.BATCH_TAG,
    row_counts: {
      mrp_demand_events: data.demandEvents.length,
      mrp_stage_weights: data.stageWeights.length,
      mrp_lead_time_actuals: data.leadTimeActuals.length,
      deals_registry: data.deals.length,
      purchase_orders: data.purchaseOrders.length,
      purchase_order_lines: data.purchaseOrderLines.length,
      po_line_receipts: data.receipts.length,
      shipment_contents_inserted: data.shipments.length,
      warehouse_stock_levels_updated: data.stockUpdates.length,
      mrp_buffer_profile_updated: data.profileUpdates.length,
    },
    // Window = the 18-month history window (2025-02..2026-07); "target" is
    // the ANNUAL_2026 constant, not scaled to the window, so combined_window
    // stays well below it for most SKUs (the window covers 12 of 2026's
    // months only through July, plus discounted 2025 months).
    per_sku_window_totals: perSku,
  };

  writeFileSync(path.join(OUT_DIR, "summary.json"), JSON.stringify(summary, null, 2), "utf8");

  console.log(`wrote ${batches.length} seed batches + teardown.sql + checks.sql + summary.json to ${OUT_DIR}`);
  console.log(JSON.stringify(summary, null, 2));
}

main();
