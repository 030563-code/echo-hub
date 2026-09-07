/**
 * generate.ts — pure generator: buildDemoData(design, todayIso) -> DemoData.
 *
 * NO IO, NO Date.now(), NO Math.random(). The only source of randomness is
 * mulberry32 seeded from design.DEMO_SEED, consumed in a FIXED order (SKU
 * outer loop in design.SKU_ORDER, month inner loop chronological), so two
 * calls with the same design always produce byte-identical rows — that fixed
 * order is also what makes the HKNA/EBH9NA date correlation possible: EBH9NA
 * (first in SKU_ORDER) is fully generated, dates and all, before HKNA runs.
 *
 * RESIDUAL SPLIT: each SKU/month's synthetic total is the modelled monthly
 * target minus real ledger demand, floored at 0 (a month where real demand
 * already exceeds the model gets no synthetic top-up — see design.ts). That
 * residual is split into pool-sized, jittered orders until what's left is
 * smaller than the next candidate order, at which point the LAST order is
 * exactly the remainder — so synthetic + real always sums to exactly the
 * modelled target whenever a residual exists (never over- or under-shoots).
 */

import * as DesignModule from "./design";

export type Design = typeof DesignModule;

// ---------------------------------------------------------------------------
// Row shapes (what generate.ts hands to emit-sql.ts)
// ---------------------------------------------------------------------------

export interface DemandEventRow {
  event_date: string; // 'YYYY-MM-DD'
  sku: string;
  qty: number;
  region: "US" | "CA";
  source: "demo_seed" | "hubspot_deal";
  source_ref: string;
}

export interface StageWeightRow {
  stage_id: string;
  stage_label: string;
  win_weight: number;
  is_late_stage: boolean;
  seeded_manually: boolean;
}

export interface LeadTimeRow {
  leg: "mfg" | "ocean" | "customs" | "door";
  days: number;
  observed_at: string; // ISO timestamp
  spot_id: string;
}

export interface DealLineItemRow {
  sku: string;
  name: string;
  currency: string;
  quantity: number;
  xero_org: string;
  unit_price: number;
  total_amount: number;
  mapping_status: "MATCHED";
  xero_item_code: string;
  discount_percentage: number;
  xero_item_description: string;
}

export interface DealRow {
  hubspot_deal_id: string;
  deal_name: string;
  deal_status: string;
  amount: number;
  currency: string;
  depot_code: string;
  line_items_raw: DealLineItemRow[];
  pipeline_name: string;
}

export interface PoRow {
  id: string;
  parent_po_id: null;
  master_ref: string;
  leg: string;
  from_entity: string;
  to_entity: string;
  status: string;
  notes: string;
  po_number: string;
  source: "hub";
  created_at?: string;
}

export interface PoLineRow {
  id: string;
  po_id: string;
  sku: string;
  product_name: string;
  quantity: number;
}

export interface ReceiptRow {
  po_id: string;
  po_line_id: string;
  qty_received: number;
  note: string;
  received_at: string;
}

export interface ShipmentRow {
  id: string;
  spot_id: string;
  container_ref: string | null;
  sku: string;
  product_name: string;
  qty: number;
  depot_destination: string;
  status: string;
  shipped_at: string; // 'YYYY-MM-DD' — column is a Postgres date
  eta: string; // 'YYYY-MM-DD'
  delivered_at: null;
  po_reference: string | null;
  po_id: string | null;
}

export interface StockUpdateRow {
  warehouse_code: string;
  sku: string;
  quantity_on_hand: number;
}

export interface ProfileUpdateRow {
  sku: string;
  moq?: number;
  container_qty?: number;
  cbm_per_unit?: number;
}

export interface DemoData {
  demandEvents: DemandEventRow[];
  stageWeights: StageWeightRow[];
  leadTimeActuals: LeadTimeRow[];
  deals: DealRow[];
  purchaseOrders: PoRow[];
  purchaseOrderLines: PoLineRow[];
  receipts: ReceiptRow[];
  shipments: ShipmentRow[];
  stockUpdates: StockUpdateRow[];
  profileUpdates: ProfileUpdateRow[];
}

// ---------------------------------------------------------------------------
// RNG — mulberry32
// ---------------------------------------------------------------------------

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function rng() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Deterministic UUIDs — '00000000-de30-4000-8000-' + zero-padded counter.
// Only needs uniqueness + determinism (never touches a real UUID v4/v5).
// ---------------------------------------------------------------------------

function demoUuid(counter: number): string {
  return `00000000-de30-4000-8000-${String(counter).padStart(12, "0")}`;
}

// ---------------------------------------------------------------------------
// Calendar helpers (pure — Date used only for calendar arithmetic, never for
// "now").
// ---------------------------------------------------------------------------

export const WINDOW_MONTHS: readonly { year: number; month: number }[] = (() => {
  const out: { year: number; month: number }[] = [];
  let y = 2025;
  let m = 2;
  while (y < 2026 || (y === 2026 && m <= 7)) {
    out.push({ year: y, month: m });
    m++;
    if (m > 12) {
      m = 1;
      y++;
    }
  }
  return out;
})();

export function monthKey(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, "0")}`;
}

export function normalizeMonthIndex(raw: readonly number[]): number[] {
  const sum = raw.reduce((a, b) => a + b, 0);
  return raw.map((w) => (w * 12) / sum);
}

/** Modelled monthly demand target: annual_2026 * normalized_index[m] / 12, halved-growth (÷1.15) for 2025 months. */
export function monthlyTarget(annual2026: number, normIndex: readonly number[], year: number, month: number): number {
  const base = (annual2026 * normIndex[month - 1]) / 12;
  return year === 2025 ? base / 1.15 : base;
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function businessDaysInMonth(year: number, month: number): string[] {
  const out: string[] = [];
  const total = daysInMonth(year, month);
  for (let d = 1; d <= total; d++) {
    const dow = new Date(Date.UTC(year, month - 1, d)).getUTCDay(); // 0=Sun..6=Sat
    if (dow >= 1 && dow <= 5) out.push(`${year}-${String(month).padStart(2, "0")}-${String(d).padStart(2, "0")}`);
  }
  return out;
}

function pickBusinessDay(rng: () => number, year: number, month: number): string {
  const days = businessDaysInMonth(year, month);
  const idx = Math.min(days.length - 1, Math.floor(rng() * days.length));
  return days[idx];
}

function monthsBackIso(fromIso: string, n: number): string {
  const [y, m, d] = fromIso.split("-").map(Number);
  let year = y;
  let month = m - n;
  while (month < 1) {
    month += 12;
    year -= 1;
  }
  return `${year}-${String(month).padStart(2, "0")}-${String(d).padStart(2, "0")}T00:00:00Z`;
}

// ---------------------------------------------------------------------------
// Order sizing — weighted pool draw, jittered, rounded to the pack multiple.
// ---------------------------------------------------------------------------

function weightedPick(rng: () => number, options: readonly DesignModule.SizeOption[]): number {
  const total = options.reduce((a, o) => a + o.weight, 0);
  let r = rng() * total;
  for (const o of options) {
    if (r < o.weight) return o.size;
    r -= o.weight;
  }
  return options[options.length - 1].size; // float-rounding safety net
}

function roundToPack(qty: number, pack: number): number {
  const rounded = Math.round(qty / pack) * pack;
  return rounded > 0 ? rounded : pack;
}

/**
 * Splits an integer residual into pool-sized orders. The final order is
 * always the exact remainder (never a jittered/rounded chunk), so the sum of
 * returned quantities is always exactly `residual`.
 */
function splitResidualIntoOrders(rng: () => number, residual: number, pool: DesignModule.SizePool): number[] {
  const orders: number[] = [];
  let remaining = Math.round(residual);
  while (remaining > 0) {
    const base = weightedPick(rng, pool.sizes);
    const jitter = 1 + (rng() * 2 - 1) * DesignModule.JITTER_RATE;
    const rounded = roundToPack(base * jitter, pool.pack);
    if (rounded >= remaining) {
      orders.push(remaining);
      remaining = 0;
    } else {
      orders.push(rounded);
      remaining -= rounded;
    }
  }
  return orders;
}

// ---------------------------------------------------------------------------
// Historical demand (batch 01 synthetic rows)
// ---------------------------------------------------------------------------

function buildHistoricalDemand(design: Design, rng: () => number): DemandEventRow[] {
  const normIndex = normalizeMonthIndex(design.MONTH_INDEX_RAW);
  const events: DemandEventRow[] = [];
  const ebh9naDatesByMonth = new Map<string, string[]>();
  let invCounter = 0;

  const nextRegion = (): "US" | "CA" => (rng() < design.REGION_SPLIT.US ? "US" : "CA");

  for (const sku of design.SKU_ORDER) {
    const annual = design.ANNUAL_2026[sku];
    const pool = design.SIZE_POOLS[sku];
    const real = design.REAL_DEMAND[sku] ?? {};

    for (const { year, month } of WINDOW_MONTHS) {
      const key = monthKey(year, month);
      const target = monthlyTarget(annual, normIndex, year, month);
      const realQty = real[key] ?? 0;
      let residual = Math.max(0, Math.round(target - realQty));

      const monthOrderQtys: number[] = [];

      for (const p of design.PROJECT_ORDERS) {
        if (p.sku === sku && p.month === key) {
          residual = Math.max(0, residual - p.qty);
          monthOrderQtys.push(p.qty);
        }
      }
      monthOrderQtys.push(...splitResidualIntoOrders(rng, residual, pool));

      for (const qty of monthOrderQtys) {
        if (qty <= 0) continue;

        let date: string;
        const ebDates = ebh9naDatesByMonth.get(key);
        if (sku === "HKNA" && ebDates && ebDates.length > 0 && rng() < design.HK_EBH9NA_CORRELATION_RATE) {
          date = ebDates[Math.floor(rng() * ebDates.length)];
        } else {
          date = pickBusinessDay(rng, year, month);
        }

        const region = nextRegion();
        invCounter++;
        events.push({
          event_date: date,
          sku,
          qty,
          region,
          source: "demo_seed",
          source_ref: `DEMO-INV-${invCounter}`,
        });

        if (sku === "EBH9NA") {
          const arr = ebh9naDatesByMonth.get(key) ?? [];
          arr.push(date);
          ebh9naDatesByMonth.set(key, arr);
        }
      }
    }
  }

  return events;
}

function buildFirmDemandEvents(design: Design): DemandEventRow[] {
  return design.FIRM_DEMAND_EVENTS.map((f) => ({
    event_date: f.event_date,
    sku: f.sku,
    qty: f.qty,
    region: design.FIRM_DEMAND_REGION,
    source: "hubspot_deal",
    source_ref: design.FIRM_DEMAND_DEAL_ID,
  }));
}

// ---------------------------------------------------------------------------
// Lead-time actuals (batch 03)
// ---------------------------------------------------------------------------

function buildLeadTimeActuals(design: Design): LeadTimeRow[] {
  const rows: LeadTimeRow[] = [];
  (Object.keys(design.LEAD_TIME_SAMPLES) as (keyof typeof design.LEAD_TIME_SAMPLES)[]).forEach((leg) => {
    design.LEAD_TIME_SAMPLES[leg].forEach((days, i) => {
      rows.push({
        leg,
        days,
        observed_at: monthsBackIso(design.LEAD_TIME_OBSERVED_FROM, i),
        spot_id: design.LEAD_TIME_SPOT_ID,
      });
    });
  });
  return rows;
}

// ---------------------------------------------------------------------------
// Deals (batch 04)
// ---------------------------------------------------------------------------

function buildDealLineItems(design: Design, depot: string, lines: readonly DesignModule.DealLineSpec[]): DealLineItemRow[] {
  const meta = design.DEPOT_META[depot];
  const suffix = design.XERO_DEPOT_SUFFIX[depot];
  return lines.map((l) => {
    const unitPrice = design.UNIT_PRICE[l.sku];
    const total = l.qty * unitPrice;
    const name = design.PRODUCT_NAMES[l.sku];
    return {
      sku: l.sku,
      name,
      currency: meta.currency,
      quantity: l.qty,
      xero_org: meta.xeroOrg,
      unit_price: unitPrice,
      total_amount: total,
      mapping_status: "MATCHED",
      xero_item_code: `${design.XERO_CODE_BASE[l.sku]}${suffix}`,
      discount_percentage: 0,
      xero_item_description: name,
    };
  });
}

function buildDeal(design: Design, spec: DesignModule.DealSpec): DealRow {
  const lineItems = buildDealLineItems(design, spec.depot, spec.lines);
  const computedAmount = lineItems.reduce((a, li) => a + li.total_amount, 0);
  const meta = design.DEPOT_META[spec.depot];
  return {
    hubspot_deal_id: spec.id,
    deal_name: spec.name,
    deal_status: spec.status,
    amount: spec.amountOverride ?? computedAmount,
    currency: meta.currency,
    depot_code: spec.depot,
    line_items_raw: lineItems,
    pipeline_name: design.PIPELINE_NAME,
  };
}

function buildDeals(design: Design): DealRow[] {
  return [...design.OPEN_PIPELINE_DEALS, ...design.LATE_STAGE_DEALS, design.CLOSED_WON_DEAL].map((spec) =>
    buildDeal(design, spec)
  );
}

// ---------------------------------------------------------------------------
// POs + lines + receipts (batch 05)
// ---------------------------------------------------------------------------

function buildPos(
  design: Design,
  nextUuid: () => string
): { pos: PoRow[]; lines: PoLineRow[]; receipts: ReceiptRow[]; poIdByNumber: Map<string, string> } {
  const pos: PoRow[] = [];
  const lines: PoLineRow[] = [];
  const receipts: ReceiptRow[] = [];
  const poIdByNumber = new Map<string, string>();

  for (const spec of design.OPENING_STOCK_POS) {
    const id = nextUuid();
    poIdByNumber.set(spec.po_number, id);
    pos.push({
      id,
      parent_po_id: null,
      master_ref: `MR-${spec.po_number}`,
      leg: "DEPOT_TO_EB_GROUP",
      from_entity: spec.depot,
      to_entity: "EB-GROUP",
      status: "delivered",
      notes: `DEMO seed — opening stock (${spec.depot})`,
      po_number: spec.po_number,
      source: "hub",
      created_at: design.OPENING_STOCK_CREATED_AT,
    });
    const stockForDepot = design.STOCK[spec.depot];
    for (const [sku, qty] of Object.entries(stockForDepot)) {
      const lineId = nextUuid();
      lines.push({ id: lineId, po_id: id, sku, product_name: design.PRODUCT_NAMES[sku], quantity: qty });
      receipts.push({
        po_id: id,
        po_line_id: lineId,
        qty_received: qty,
        note: "DEMO seed — opening stock receipt",
        received_at: design.OPENING_STOCK_RECEIVED_AT,
      });
    }
  }

  for (const spec of design.OPEN_POS) {
    const id = nextUuid();
    poIdByNumber.set(spec.po_number, id);
    pos.push({
      id,
      parent_po_id: null,
      master_ref: `MR-${spec.po_number}`,
      leg: "DEPOT_TO_EB_GROUP",
      from_entity: spec.depot,
      to_entity: "EB-GROUP",
      status: spec.status,
      notes: `DEMO seed — open order (${spec.depot})`,
      po_number: spec.po_number,
      source: "hub",
      created_at: design.OPEN_PO_CREATED_AT,
    });
    for (const l of spec.lines) {
      const lineId = nextUuid();
      lines.push({ id: lineId, po_id: id, sku: l.sku, product_name: design.PRODUCT_NAMES[l.sku], quantity: l.qty });
    }
  }

  return { pos, lines, receipts, poIdByNumber };
}

// ---------------------------------------------------------------------------
// Shipments (batch 06 inserts — the stale-row status flip is emitted directly
// as marker-based SQL in emit-sql.ts and needs no row data from here)
// ---------------------------------------------------------------------------

function buildShipments(design: Design, nextUuid: () => string, poIdByNumber: Map<string, string>): ShipmentRow[] {
  const rows: ShipmentRow[] = [];
  for (const spec of design.DEMO_SHIPMENTS) {
    const poId = spec.po_number ? (poIdByNumber.get(spec.po_number) ?? null) : null;
    for (const line of spec.lines) {
      rows.push({
        id: nextUuid(),
        spot_id: spec.spot_id,
        container_ref: spec.container_ref,
        sku: line.sku,
        product_name: design.PRODUCT_NAMES[line.sku],
        qty: line.qty,
        depot_destination: spec.depot,
        status: spec.status,
        shipped_at: spec.shipped_at,
        eta: spec.eta,
        delivered_at: null,
        po_reference: spec.po_number,
        po_id: poId,
      });
    }
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Stock + profile updates (batches 07/08)
// ---------------------------------------------------------------------------

function buildStockUpdates(design: Design): StockUpdateRow[] {
  const rows: StockUpdateRow[] = [];
  for (const [warehouse_code, skus] of Object.entries(design.STOCK)) {
    for (const [sku, quantity_on_hand] of Object.entries(skus)) {
      rows.push({ warehouse_code, sku, quantity_on_hand });
    }
  }
  return rows;
}

function buildProfileUpdates(design: Design): ProfileUpdateRow[] {
  const skus = new Set<string>([
    ...Object.keys(design.PROFILE_CONTAINER_QTY),
    ...Object.keys(design.PROFILE_CBM_PER_UNIT),
    ...Object.keys(design.PROFILE_MOQ),
  ]);
  return [...skus].sort().map((sku) => ({
    sku,
    moq: design.PROFILE_MOQ[sku],
    container_qty: design.PROFILE_CONTAINER_QTY[sku],
    cbm_per_unit: design.PROFILE_CBM_PER_UNIT[sku],
  }));
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function buildDemoData(design: Design, todayIso: string): DemoData {
  // Every date in this dataset is a fixed design constant (the window ends
  // 2026-07-31, firm demand lands 2026-08-06) — todayIso is accepted per the
  // spec'd signature and is not currently consulted, but keeping it in the
  // signature lets a future run re-anchor "today" without an API change.
  void todayIso;

  const rng = mulberry32(design.DEMO_SEED);

  const demandEvents = [...buildHistoricalDemand(design, rng), ...buildFirmDemandEvents(design)];
  const stageWeights: StageWeightRow[] = [design.STAGE_WEIGHT_ROW];
  const leadTimeActuals = buildLeadTimeActuals(design);
  const deals = buildDeals(design);

  let uuidCounter = 0;
  const nextUuid = () => demoUuid(++uuidCounter);
  const { pos, lines, receipts, poIdByNumber } = buildPos(design, nextUuid);
  const shipments = buildShipments(design, nextUuid, poIdByNumber);

  const stockUpdates = buildStockUpdates(design);
  const profileUpdates = buildProfileUpdates(design);

  return {
    demandEvents,
    stageWeights,
    leadTimeActuals,
    deals,
    purchaseOrders: pos,
    purchaseOrderLines: lines,
    receipts,
    shipments,
    stockUpdates,
    profileUpdates,
  };
}
