/**
 * emit-sql.ts — turns a DemoData bundle into SQL text. No IO, no DB access:
 * this module only builds strings.
 *
 * Two different registry-capture shapes, per the identification & teardown
 * contract:
 *   - INSERT rows (demand events, deals, POs, ...): we already KNOW the
 *     identifying columns (we chose them), so the registry row is a literal
 *     `insert ... values (...)`.
 *   - UPDATE rows (stock, buffer profile, the stale shipment status flip):
 *     we do NOT know the pre-seed values — only the live DB does — so the
 *     registry row is `insert ... select <cols> from <table> where <pk>`,
 *     executed immediately before the UPDATE it documents.
 *
 * Batches 04 (deals), 05 (POs) and 06 (shipments) run with
 * `session_replication_role = replica` to silence AFTER-INSERT webhook
 * triggers on the live DB — see design.ts / the spec for why. Every other
 * batch runs with normal trigger behaviour.
 */

import * as design from "./design";
import type { DemoData } from "./generate";

const MAX_ROWS_PER_INSERT = 200;

// ---------------------------------------------------------------------------
// Literal helpers
// ---------------------------------------------------------------------------

function esc(s: string): string {
  return s.replace(/'/g, "''");
}

function str(s: string): string {
  return `'${esc(s)}'`;
}

function strOrNull(s: string | null): string {
  return s === null ? "null" : str(s);
}

function num(n: number): string {
  return String(n);
}

function bool(b: boolean): string {
  return b ? "true" : "false";
}

function jsonbLit(v: unknown): string {
  return `'${esc(JSON.stringify(v))}'::jsonb`;
}

function chunk<T>(arr: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function wrapBatch(body: string, opts?: { replica?: boolean }): string {
  const lines = ["begin;"];
  if (opts?.replica) lines.push("set local session_replication_role = replica;");
  lines.push(body.trim());
  lines.push("commit;");
  return lines.join("\n\n") + "\n";
}

/** Literal `insert ... values` registry rows for a batch of known-at-generation-time INSERTs. */
function registryInsertValues(tableName: string, pks: readonly Record<string, unknown>[]): string {
  if (pks.length === 0) return "";
  const rows = pks.map((pk) => `(${str(design.BATCH_TAG)}, 'insert', ${str(tableName)}, ${jsonbLit(pk)}, null)`);
  return chunk(rows, MAX_ROWS_PER_INSERT)
    .map(
      (c) =>
        `insert into public.mrp_demo_seed_registry (batch_tag, op, table_name, pk, prior) values\n  ${c.join(",\n  ")};`
    )
    .join("\n\n");
}

// ---------------------------------------------------------------------------
// Batch 00 — registry table itself
// ---------------------------------------------------------------------------

function emitRegistryBatch(): string {
  const body = `
create table public.mrp_demo_seed_registry (
  id bigint generated always as identity primary key,
  batch_tag text not null,
  op text not null check (op in ('insert', 'update')),
  table_name text not null,
  pk jsonb not null,
  prior jsonb,
  created_at timestamptz not null default now()
);

alter table public.mrp_demo_seed_registry enable row level security;

revoke all on public.mrp_demo_seed_registry from anon, authenticated;
`.trim();
  return wrapBatch(body);
}

// ---------------------------------------------------------------------------
// Batch 01 — demand
// ---------------------------------------------------------------------------

function emitDemandBatch(data: DemoData): string {
  const rows = data.demandEvents;
  const inserts = chunk(rows, MAX_ROWS_PER_INSERT)
    .map(
      (c) =>
        `insert into public.mrp_demand_events (event_date, sku, qty, region, source, source_ref) values\n  ` +
        c
          .map(
            (r) =>
              `(${str(r.event_date)}, ${str(r.sku)}, ${num(r.qty)}, ${str(r.region)}, ${str(r.source)}, ${str(r.source_ref)})`
          )
          .join(",\n  ") +
        `\non conflict (source, source_ref, sku) do nothing;`
    )
    .join("\n\n");

  const registry = registryInsertValues(
    "mrp_demand_events",
    rows.map((r) => ({ source: r.source, source_ref: r.source_ref, sku: r.sku }))
  );

  return wrapBatch([inserts, registry].filter(Boolean).join("\n\n"));
}

// ---------------------------------------------------------------------------
// Batch 02 — stage weight
// ---------------------------------------------------------------------------

function emitStageWeightBatch(data: DemoData): string {
  const row = data.stageWeights[0];
  const insert =
    `insert into public.mrp_stage_weights (stage_id, stage_label, win_weight, is_late_stage, seeded_manually) values\n` +
    `  (${str(row.stage_id)}, ${str(row.stage_label)}, ${num(row.win_weight)}, ${bool(row.is_late_stage)}, ${bool(row.seeded_manually)})\n` +
    `on conflict (stage_id) do nothing;`;
  const registry = registryInsertValues("mrp_stage_weights", [{ stage_id: row.stage_id }]);
  return wrapBatch([insert, registry].join("\n\n"));
}

// ---------------------------------------------------------------------------
// Batch 03 — lead-time actuals
// ---------------------------------------------------------------------------

function emitLeadTimeBatch(data: DemoData): string {
  const rows = data.leadTimeActuals;
  const inserts = chunk(rows, MAX_ROWS_PER_INSERT)
    .map(
      (c) =>
        `insert into public.mrp_lead_time_actuals (leg, days, observed_at, spot_id) values\n  ` +
        c.map((r) => `(${str(r.leg)}, ${num(r.days)}, ${str(r.observed_at)}, ${str(r.spot_id)})`).join(",\n  ") +
        ";"
    )
    .join("\n\n");

  const registry = registryInsertValues(
    "mrp_lead_time_actuals",
    rows.map((r) => ({ leg: r.leg, observed_at: r.observed_at, spot_id: r.spot_id }))
  );

  return wrapBatch([inserts, registry].filter(Boolean).join("\n\n"));
}

// ---------------------------------------------------------------------------
// Batch 04 — deals (replica)
// ---------------------------------------------------------------------------

function emitDealsBatch(data: DemoData): string {
  const rows = data.deals;
  const inserts = chunk(rows, MAX_ROWS_PER_INSERT)
    .map(
      (c) =>
        `insert into public.deals_registry (hubspot_deal_id, deal_name, deal_status, amount, currency, depot_code, line_items_raw, pipeline_name) values\n  ` +
        c
          .map(
            (r) =>
              `(${str(r.hubspot_deal_id)}, ${str(r.deal_name)}, ${str(r.deal_status)}, ${num(r.amount)}, ${str(r.currency)}, ${str(r.depot_code)}, ${jsonbLit(r.line_items_raw)}, ${str(r.pipeline_name)})`
          )
          .join(",\n  ") +
        ";"
    )
    .join("\n\n");

  const registry = registryInsertValues(
    "deals_registry",
    rows.map((r) => ({ hubspot_deal_id: r.hubspot_deal_id }))
  );

  return wrapBatch([inserts, registry].filter(Boolean).join("\n\n"), { replica: true });
}

// ---------------------------------------------------------------------------
// Batch 05 — POs + lines + receipts (replica)
// ---------------------------------------------------------------------------

function emitPosBatch(data: DemoData): string {
  const poInserts = chunk(data.purchaseOrders, MAX_ROWS_PER_INSERT)
    .map(
      (c) =>
        `insert into public.purchase_orders (id, parent_po_id, master_ref, leg, from_entity, to_entity, status, notes, po_number, source, created_at) values\n  ` +
        c
          .map(
            (r) =>
              `(${str(r.id)}, null, ${str(r.master_ref)}, ${str(r.leg)}, ${str(r.from_entity)}, ${str(r.to_entity)}, ${str(r.status)}, ${str(r.notes)}, ${str(r.po_number)}, ${str(r.source)}, ${r.created_at ? str(r.created_at) : "default"})`
          )
          .join(",\n  ") +
        `\non conflict (po_number) do nothing;`
    )
    .join("\n\n");
  const poRegistry = registryInsertValues(
    "purchase_orders",
    data.purchaseOrders.map((r) => ({ po_number: r.po_number }))
  );

  const lineInserts = chunk(data.purchaseOrderLines, MAX_ROWS_PER_INSERT)
    .map(
      (c) =>
        `insert into public.purchase_order_lines (id, po_id, sku, product_name, quantity) values\n  ` +
        c.map((r) => `(${str(r.id)}, ${str(r.po_id)}, ${str(r.sku)}, ${str(r.product_name)}, ${num(r.quantity)})`).join(",\n  ") +
        ";"
    )
    .join("\n\n");
  const lineRegistry = registryInsertValues(
    "purchase_order_lines",
    data.purchaseOrderLines.map((r) => ({ id: r.id }))
  );

  const receiptInserts = chunk(data.receipts, MAX_ROWS_PER_INSERT)
    .map(
      (c) =>
        `insert into public.po_line_receipts (po_id, po_line_id, qty_received, note, received_at) values\n  ` +
        c
          .map(
            (r) => `(${str(r.po_id)}, ${str(r.po_line_id)}, ${num(r.qty_received)}, ${str(r.note)}, ${str(r.received_at)})`
          )
          .join(",\n  ") +
        ";"
    )
    .join("\n\n");
  const receiptRegistry = registryInsertValues(
    "po_line_receipts",
    data.receipts.map((r) => ({ po_id: r.po_id, po_line_id: r.po_line_id }))
  );

  return wrapBatch(
    [poInserts, poRegistry, lineInserts, lineRegistry, receiptInserts, receiptRegistry].filter(Boolean).join("\n\n"),
    { replica: true }
  );
}

// ---------------------------------------------------------------------------
// Batch 06 — shipments (replica)
// ---------------------------------------------------------------------------

function emitShipmentsBatch(data: DemoData): string {
  const captureStale =
    `insert into public.mrp_demo_seed_registry (batch_tag, op, table_name, pk, prior)\n` +
    `select ${str(design.BATCH_TAG)}, 'update', 'shipment_contents', jsonb_build_object('id', id), jsonb_build_object('status', status, 'delivered_at', delivered_at)\n` +
    `from public.shipment_contents\n` +
    `where status <> 'delivered' and spot_id not like 'DEMO-%';`;

  const updateStale =
    `update public.shipment_contents\n` +
    `set status = 'delivered', delivered_at = eta + interval '3 days'\n` +
    `where status <> 'delivered' and spot_id not like 'DEMO-%';`;

  const inserts = chunk(data.shipments, MAX_ROWS_PER_INSERT)
    .map(
      (c) =>
        `insert into public.shipment_contents (id, spot_id, container_ref, sku, product_name, qty, depot_destination, status, shipped_at, eta, delivered_at, po_reference, po_id) values\n  ` +
        c
          .map(
            (r) =>
              `(${str(r.id)}, ${str(r.spot_id)}, ${strOrNull(r.container_ref)}, ${str(r.sku)}, ${str(r.product_name)}, ${num(r.qty)}, ${str(r.depot_destination)}, ${str(r.status)}, ${str(r.shipped_at)}, ${str(r.eta)}, null, ${strOrNull(r.po_reference)}, ${strOrNull(r.po_id)})`
          )
          .join(",\n  ") +
        ";"
    )
    .join("\n\n");
  const insertRegistry = registryInsertValues(
    "shipment_contents",
    data.shipments.map((r) => ({ id: r.id }))
  );

  return wrapBatch([captureStale, updateStale, inserts, insertRegistry].filter(Boolean).join("\n\n"), { replica: true });
}

// ---------------------------------------------------------------------------
// Batch 07 — stock (UPDATE only, capture-then-update per row)
// ---------------------------------------------------------------------------

function emitStockBatch(data: DemoData): string {
  const parts: string[] = [];
  for (const r of data.stockUpdates) {
    const pk = jsonbLit({ warehouse_code: r.warehouse_code, sku: r.sku });
    parts.push(
      `insert into public.mrp_demo_seed_registry (batch_tag, op, table_name, pk, prior)\n` +
        `select ${str(design.BATCH_TAG)}, 'update', 'warehouse_stock_levels', ${pk}, jsonb_build_object('quantity_on_hand', quantity_on_hand, 'last_counted_at', last_counted_at)\n` +
        `from public.warehouse_stock_levels\n` +
        `where warehouse_code = ${str(r.warehouse_code)} and sku = ${str(r.sku)};`
    );
    parts.push(
      `update public.warehouse_stock_levels\n` +
        `set quantity_on_hand = ${num(r.quantity_on_hand)}, last_counted_at = ${str(design.STOCK_LAST_COUNTED_AT)}\n` +
        `where warehouse_code = ${str(r.warehouse_code)} and sku = ${str(r.sku)};`
    );
  }
  return wrapBatch(parts.join("\n\n"));
}

// ---------------------------------------------------------------------------
// Batch 08 — buffer profiles (UPDATE only; only the touched columns are
// captured/set per SKU)
// ---------------------------------------------------------------------------

function emitProfilesBatch(data: DemoData): string {
  const parts: string[] = [];
  for (const r of data.profileUpdates) {
    const touched: string[] = [];
    const setClauses: string[] = [];
    if (r.moq !== undefined) {
      touched.push("moq");
      setClauses.push(`moq = ${num(r.moq)}`);
    }
    if (r.container_qty !== undefined) {
      touched.push("container_qty");
      setClauses.push(`container_qty = ${num(r.container_qty)}`);
    }
    if (r.cbm_per_unit !== undefined) {
      touched.push("cbm_per_unit");
      setClauses.push(`cbm_per_unit = ${num(r.cbm_per_unit)}`);
    }
    if (setClauses.length === 0) continue;

    const priorFields = touched.map((k) => `'${k}', ${k}`).join(", ");
    parts.push(
      `insert into public.mrp_demo_seed_registry (batch_tag, op, table_name, pk, prior)\n` +
        `select ${str(design.BATCH_TAG)}, 'update', 'mrp_buffer_profile', jsonb_build_object('sku', sku), jsonb_build_object(${priorFields})\n` +
        `from public.mrp_buffer_profile\n` +
        `where sku = ${str(r.sku)};`
    );
    parts.push(`update public.mrp_buffer_profile\nset ${setClauses.join(", ")}\nwhere sku = ${str(r.sku)};`);
  }
  return wrapBatch(parts.join("\n\n"));
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** One string per batch file, in the fixed order: 00-registry .. 08-profiles. */
export function emitSeedSql(data: DemoData): string[] {
  return [
    emitRegistryBatch(),
    emitDemandBatch(data),
    emitStageWeightBatch(data),
    emitLeadTimeBatch(data),
    emitDealsBatch(data),
    emitPosBatch(data),
    emitShipmentsBatch(data),
    emitStockBatch(data),
    emitProfilesBatch(data),
  ];
}

export function emitTeardownSql(data: DemoData): string {
  void data; // teardown targets are marker/registry-driven, not row-specific.
  const tag = str(design.BATCH_TAG);

  const body = `
-- 1. Restore UPDATEd rows from registry prior values.
update public.warehouse_stock_levels w
set quantity_on_hand = (r.prior->>'quantity_on_hand')::integer,
    last_counted_at = (r.prior->>'last_counted_at')::timestamptz
from public.mrp_demo_seed_registry r
where r.batch_tag = ${tag} and r.op = 'update' and r.table_name = 'warehouse_stock_levels'
  and w.warehouse_code = r.pk->>'warehouse_code' and w.sku = r.pk->>'sku';

update public.shipment_contents s
set status = r.prior->>'status',
    delivered_at = (r.prior->>'delivered_at')::timestamptz
from public.mrp_demo_seed_registry r
where r.batch_tag = ${tag} and r.op = 'update' and r.table_name = 'shipment_contents'
  and s.id = (r.pk->>'id')::uuid;

update public.mrp_buffer_profile p
set moq = case when r.prior ? 'moq' then (r.prior->>'moq')::integer else p.moq end,
    container_qty = case when r.prior ? 'container_qty' then (r.prior->>'container_qty')::integer else p.container_qty end,
    cbm_per_unit = case when r.prior ? 'cbm_per_unit' then (r.prior->>'cbm_per_unit')::numeric else p.cbm_per_unit end
from public.mrp_demo_seed_registry r
where r.batch_tag = ${tag} and r.op = 'update' and r.table_name = 'mrp_buffer_profile'
  and p.sku = r.pk->>'sku';

-- 2. Delete inserts, FK-safe reverse order (children before parents).
-- 'MRPD-%' covers chains the ENGINE drafts at run time (mrp_draft_po_chain)
-- while demo data is loaded — engine output, so the seed registry never saw
-- them, but they exist only because of seeded demand and must go too.
delete from public.po_line_receipts rcpt
using public.purchase_orders po
where rcpt.po_id = po.id and (po.po_number like 'DEMO-%' or po.po_number like 'MRPD-%');

delete from public.purchase_order_lines pol
using public.purchase_orders po
where pol.po_id = po.id and (po.po_number like 'DEMO-%' or po.po_number like 'MRPD-%');

delete from public.purchase_orders
where (po_number like 'DEMO-%' or po_number like 'MRPD-%') and parent_po_id is not null;

delete from public.purchase_orders
where po_number like 'DEMO-%' or po_number like 'MRPD-%';

delete from public.shipment_contents
where spot_id like 'DEMO-SPOT-%';

delete from public.deals_registry
where hubspot_deal_id like 'DEMO-%';

delete from public.mrp_demand_events
where source_ref like 'DEMO-%';

delete from public.mrp_lead_time_actuals
where spot_id = 'DEMO';

delete from public.mrp_stage_weights
where stage_id = 'demo_late_stage';

-- 3. Delete engine output computed from demo inputs.
delete from public.mrp_buffer_status_daily
where run_date >= '${design.TODAY}';

delete from public.mrp_spike_register
where run_date >= '${design.TODAY}';

-- 4. Drop the registry last.
drop table if exists public.mrp_demo_seed_registry;
`.trim();

  return wrapBatch(body);
}
