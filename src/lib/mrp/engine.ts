/**
 * MRP nightly engine — assembles DDMRP buffer inputs per profile SKU and
 * persists mrp_buffer_status_daily rows + qualified spikes.
 *
 * PURE ASSEMBLY over an injectable data-access layer (EngineData): every read
 * and write goes through the interface, so unit tests stub row fixtures and
 * the API route wires the Supabase admin adapter (engine-data.ts). No IO, no
 * env, no ambient dates in this module — `now` is injectable.
 *
 * ALIAS ROUTING (mrp_buffer_profile.alias_of): the demand ledger is an
 * append-only audit log whose SKU spellings are historical fact. Profile rows
 * with alias_of set declare "this spelling means that SKU": every sku-keyed
 * input (demand events, stock, shipments, PO lines, deal line items, BOM rows)
 * is routed through the alias map before aggregation, and alias rows are
 * EXCLUDED from buffer computation, persistence, and spikes. Aliases are
 * single-level by contract (see the column comment).
 */

import {
  computeZones,
  computeNFP,
  zoneFor,
  varFactorFromCov,
  qualifySpikes,
  type SpikeCandidate,
} from "./buffers";
import { materialsCeiling, type BomComponentRow, type BomProductRow } from "./materials";

export type { BomComponentRow, BomProductRow };

// ---------------------------------------------------------------------------
// Tunable constants (DDS&OP-reviewable heuristics — change here, not inline)
// ---------------------------------------------------------------------------

/** ADU = trailing-window demand qty / this many days. */
export const ADU_WINDOW_DAYS = 180;

/** CoV is measured over this many trailing ISO weeks, INCLUDING zero weeks. */
export const COV_WEEKS = 52;

/**
 * Firm demand heuristic: hubspot_deal demand events dated within this many
 * days are presumed won-but-not-yet-shipped and still ahead of the stock
 * ledger (shipping them decrements warehouse_stock_levels; until then the
 * commitment must reduce NFP). 14d is a judgment call on typical
 * close→dispatch latency — DDS&OP-tunable.
 */
export const FIRM_DEMAND_WINDOW_DAYS = 14;

/** Spike horizon = DLT + this pad (per the buffers-lib contract). */
export const SPIKE_HORIZON_PAD_DAYS = 30;

/** Door-leg actuals only recalibrate DLT once this many observations exist. */
export const MIN_DOOR_ACTUALS = 10;

/** Fewer ADU-window demand events than this ⇒ 'thin_history' flag. */
export const THIN_HISTORY_MIN_EVENTS = 5;

const MS_PER_DAY = 86_400_000;

// ---------------------------------------------------------------------------
// Row shapes (as returned by the data layer)
// ---------------------------------------------------------------------------

export interface ProfileRow {
  sku: string;
  sku_class: string;
  family_sku: string | null;
  adu: number | null;
  adu_source: "auto" | "manual";
  cov: number | null;
  dlt_days: number;
  mfg_lt: number;
  ocean_lt: number;
  customs_lt: number;
  lt_factor: number;
  var_factor: number | null;
  moq: number;
  container_qty: number | null;
  seeded: boolean;
  alias_of: string | null;
}

export interface DemandEventRow {
  event_date: string; // 'YYYY-MM-DD'
  sku: string;
  qty: number;
  source: string;
}

export interface StockRow {
  warehouse_code: string;
  sku: string;
  quantity_on_hand: number;
  last_counted_at: string | null;
}

export interface ShipmentRow {
  sku: string;
  qty: number;
  status: string;
  po_id: string | null;
}

export interface OpenPoLineRow {
  po_id: string;
  sku: string;
  quantity: number;
}

export interface StageWeightRow {
  stage_id: string;
  win_weight: number;
  is_late_stage: boolean;
}

export interface DealRow {
  hubspot_deal_id: string;
  deal_status: string;
  line_items_raw: unknown;
}

export interface BomSkuMapRow {
  hub_sku: string;
  fg_code: string;
  confirmed: boolean;
}

export interface MaterialStockRow {
  ns_number: string;
  /**
   * PHYSICAL stock on hand. Deliberately not available_quantity: that column is
   * quantity minus reservations Bamida never drains, so it runs deeply negative
   * on fast movers (orange thread -165,717 m against 75,093 m on the shelf) and
   * would make every product permanently unbuildable.
   */
  quantity: number;
}

export interface ReceiptRow {
  depot: string;
  sku: string;
  qty: number;
}

// ---------------------------------------------------------------------------
// Output shapes
// ---------------------------------------------------------------------------

export interface StatusDailyRow {
  run_date: string;
  sku: string;
  on_hand: number;
  in_transit: number;
  on_order: number;
  firm_demand: number;
  qualified_spikes: number; // Σ(qty × weight) over qualified spikes (the NFP deduction)
  nfp: number;
  projected_nfp: number;
  red: number;
  yellow_top: number;
  green_top: number;
  zone: "red" | "yellow" | "green";
  action_qty: number;
  max_buildable: number | null;
  /** ns_number of the component capping max_buildable — the thing to reorder. */
  materials_binding_code: string | null;
  materials_binding_desc: string | null;
  blocked_by_materials: boolean;
  flags: string[]; // jsonb ARRAY of strings — never an object
}

export interface SpikeRegisterRow {
  run_date: string;
  deal_id: string;
  sku: string;
  qty: number;
  due_date: string | null; // null today: deals carry no close date (see spikes note)
  weight: number;
  qualified: boolean;
}

export interface ProfileWriteBack {
  sku: string;
  adu?: number | null;
  cov?: number | null;
  var_factor?: number | null;
  dlt_days: number;
  seeded: true;
  updated_at: string; // set explicitly — mrp_buffer_profile has NO touch trigger
}

export interface EngineData {
  profiles(): Promise<ProfileRow[]>;
  /** US/CA demand events with event_date > since (lower bound only — see ADU note). */
  demandEvents(since: string): Promise<DemandEventRow[]>;
  stockLevels(): Promise<StockRow[]>;
  shipments(): Promise<ShipmentRow[]>;
  /** Lines of OPEN Hub POs: source='hub', leg='DEPOT_TO_EB_GROUP', status in requested/approved/shipped. */
  openPoLines(): Promise<OpenPoLineRow[]>;
  stageWeights(): Promise<StageWeightRow[]>;
  /** Deals with status NOT closedwon/closedlost and non-null line_items_raw. */
  openDeals(): Promise<DealRow[]>;
  /** closedwon deals with non-null line_items_raw (reconciliation net a). */
  closedWonDeals(): Promise<DealRow[]>;
  /** Distinct source_ref of source='hubspot_deal' demand events. */
  hubspotDemandDealIds(): Promise<Set<string>>;
  bomProducts(): Promise<BomProductRow[]>;
  bomComponents(): Promise<BomComponentRow[]>;
  bomSkuMap(): Promise<BomSkuMapRow[]>;
  materialStock(): Promise<MaterialStockRow[]>;
  /** days of leg='door' mrp_lead_time_actuals. */
  doorLeadTimeDays(): Promise<number[]>;
  /** Per-receipt (depot, sku, qty) on delivered/approved Hub POs (net b). */
  receiptRows(): Promise<ReceiptRow[]>;
  persistStatus(rows: StatusDailyRow[]): Promise<void>;
  persistSpikes(rows: SpikeRegisterRow[]): Promise<void>;
  writeBackProfiles(updates: ProfileWriteBack[]): Promise<void>;
}

export interface EngineOptions {
  now?: Date;
  /** Read + compute only — no status/spike/profile writes (live smoke path). */
  dryRun?: boolean;
}

export interface EngineResult {
  run_date: string;
  skus: number;
  reds: number;
  yellows: number;
  greens: number;
  blocked: number;
  warnings: string[];
  rows: StatusDailyRow[];
  spikes: SpikeRegisterRow[];
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit tests)
// ---------------------------------------------------------------------------

/**
 * Parse a deals_registry.line_items_raw jsonb value. Both live generations of
 * element shape (snake_case and camelCase) use the keys "sku" and "quantity"
 * (verified in the Task 1 backfill); quantity may arrive as a numeric string.
 * Non-arrays, blank SKUs, and non-positive quantities yield nothing.
 */
export function parseLineItems(raw: unknown): { sku: string; qty: number }[] {
  if (!Array.isArray(raw)) return [];
  const out: { sku: string; qty: number }[] = [];
  for (const el of raw) {
    if (typeof el !== "object" || el === null) continue;
    const rec = el as Record<string, unknown>;
    const sku = typeof rec.sku === "string" ? rec.sku.trim() : "";
    const qtyRaw = rec.quantity;
    const qty =
      typeof qtyRaw === "number" ? qtyRaw : typeof qtyRaw === "string" ? Number(qtyRaw.trim()) : NaN;
    if (sku !== "" && Number.isFinite(qty) && qty > 0) out.push({ sku, qty });
  }
  return out;
}

/** ISO-8601 week key ('2026-W32') of a date, computed in UTC. */
export function isoWeekKey(d: Date): string {
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = date.getUTCDay() || 7; // Mon=1 … Sun=7
  date.setUTCDate(date.getUTCDate() + 4 - day); // shift to the ISO week's Thursday
  const year = date.getUTCFullYear();
  const week = Math.ceil(((date.getTime() - Date.UTC(year, 0, 1)) / MS_PER_DAY + 1) / 7);
  return `${year}-W${String(week).padStart(2, "0")}`;
}

/** The `n` consecutive ISO week keys ending with the week containing `end`. */
export function trailingIsoWeeks(end: Date, n: number): string[] {
  const out: string[] = [];
  for (let i = n - 1; i >= 0; i--) out.push(isoWeekKey(new Date(end.getTime() - i * 7 * MS_PER_DAY)));
  return out;
}

/**
 * Weekly demand totals over an explicit week-key list. Weeks with no events
 * stay 0 (CoV must include zero weeks — a SKU that sells once a quarter is
 * high-variability, not smooth). Events outside the listed weeks (older, or
 * future-dated past the current week) are ignored.
 */
export function weeklyTotals(events: { event_date: string; qty: number }[], weeks: string[]): number[] {
  const byWeek = new Map<string, number>(weeks.map((w) => [w, 0]));
  for (const e of events) {
    const key = isoWeekKey(new Date(`${e.event_date}T00:00:00Z`));
    const cur = byWeek.get(key);
    if (cur !== undefined) byWeek.set(key, cur + e.qty);
  }
  return weeks.map((w) => byWeek.get(w) ?? 0);
}

/**
 * Coefficient of variation (population σ / mean) of weekly totals.
 * Null when there are no weeks or mean is 0 (undefined CoV — the caller maps
 * null to the most conservative variability bucket via varFactorFromCov).
 */
export function covFromWeeklyTotals(totals: number[]): number | null {
  const n = totals.length;
  if (n === 0) return null;
  const mean = totals.reduce((a, b) => a + b, 0) / n;
  if (mean === 0) return null;
  const variance = totals.reduce((a, x) => a + (x - mean) ** 2, 0) / n;
  return Math.sqrt(variance) / mean;
}

export function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * Decoupled lead time. Once enough composite 'door' actuals exist they REPLACE
 * the ocean+customs seed: DLT = mfg + median(door). 'door' observations are
 * port-to-door spans covering ocean + customs + inland + receipt-logging delay
 * (see the mrp_lead_time_actuals.leg column comment) — mfg + ocean + door
 * would double-count the ocean leg and is deliberately impossible here.
 */
export function dltDaysFor(
  p: { mfg_lt: number; ocean_lt: number; customs_lt: number },
  doorActualDays: number[]
): number {
  if (doorActualDays.length >= MIN_DOOR_ACTUALS) return p.mfg_lt + Math.round(median(doorActualDays));
  return p.mfg_lt + p.ocean_lt + p.customs_lt;
}

/**
 * On-order per canonical SKU: open Hub depot-leg PO line qty MINUS the qty of
 * not-yet-delivered shipment rows LINKED (po_id) to those POs — a shipment row
 * already counts in in_transit, so its PO qty would otherwise double-count
 * (audit finding 3). Unlinked shipments (po_id null — all 11 live rows today)
 * reduce nothing; the dedup is coded for the day links land. Clamped at 0.
 */
export function onOrderBySku(
  openLines: OpenPoLineRow[],
  shipments: ShipmentRow[],
  resolve: (sku: string) => string
): Map<string, number> {
  const openPoIds = new Set(openLines.map((l) => l.po_id));
  const gross = new Map<string, number>();
  for (const l of openLines) {
    const sku = resolve(l.sku);
    gross.set(sku, (gross.get(sku) ?? 0) + l.quantity);
  }
  for (const s of shipments) {
    if (s.status === "delivered" || !s.po_id || !openPoIds.has(s.po_id)) continue;
    const sku = resolve(s.sku);
    if (gross.has(sku)) gross.set(sku, Math.max(0, (gross.get(sku) ?? 0) - s.qty));
  }
  return gross;
}

const isoDate = (d: Date) => d.toISOString().slice(0, 10);
const daysBefore = (d: Date, days: number) => new Date(d.getTime() - days * MS_PER_DAY);

// ---------------------------------------------------------------------------
// The engine
// ---------------------------------------------------------------------------

export async function runMrpEngine(data: EngineData, opts: EngineOptions = {}): Promise<EngineResult> {
  const now = opts.now ?? new Date();
  const runDate = isoDate(now);
  const warnings: string[] = [];

  // Fetch window: CoV needs 52 ISO weeks (364d); the earliest of those weeks
  // can start up to 6 days before now−364d, so fetch 371d back and let
  // weeklyTotals do the exact bucketing. The ADU window (180d) is a subset.
  const fetchSince = isoDate(daysBefore(now, COV_WEEKS * 7 + 7));

  const [
    profiles,
    events,
    stockRows,
    shipmentRows,
    openLines,
    stageWeightRows,
    openDealRows,
    closedWonRows,
    demandDealIds,
    bomProductRows,
    bomComponentRows,
    bomSkuMapRows,
    materialRows,
    doorDays,
    receiptRows,
  ] = await Promise.all([
    data.profiles(),
    data.demandEvents(fetchSince),
    data.stockLevels(),
    data.shipments(),
    data.openPoLines(),
    data.stageWeights(),
    data.openDeals(),
    data.closedWonDeals(),
    data.hubspotDemandDealIds(),
    data.bomProducts(),
    data.bomComponents(),
    data.bomSkuMap(),
    data.materialStock(),
    data.doorLeadTimeDays(),
    data.receiptRows(),
  ]);

  // --- alias routing --------------------------------------------------------
  const aliasMap = new Map<string, string>();
  for (const p of profiles) if (p.alias_of !== null) aliasMap.set(p.sku, p.alias_of);
  // Chain guard: aliases are single-level by contract (see the alias_of column
  // comment). A target that is itself an alias would swallow demand silently —
  // resolve() stops at the target, which is excluded from computation, so the
  // rolled-up qty lands on a SKU no buffer is computed for.
  for (const [sku, target] of aliasMap) {
    if (aliasMap.has(target)) warnings.push(`alias_chain:${sku}->${target}`);
  }
  const resolve = (sku: string) => aliasMap.get(sku) ?? sku;
  const computed = profiles.filter((p) => p.alias_of === null);

  // --- shared aggregations --------------------------------------------------
  // ADU window is LOWER-BOUNDED ONLY: Xero-backfilled events carry due_date as
  // event_date, so recent invoices can be dated days-to-weeks in the future —
  // an upper bound at `now` would make the newest demand invisible until its
  // payment due date passes. The divisor stays ADU_WINDOW_DAYS.
  const aduSince = isoDate(daysBefore(now, ADU_WINDOW_DAYS));
  const firmSince = isoDate(daysBefore(now, FIRM_DEMAND_WINDOW_DAYS));
  const covWeeks = trailingIsoWeeks(now, COV_WEEKS);

  const eventsBySku = new Map<string, DemandEventRow[]>();
  for (const e of events) {
    const sku = resolve(e.sku);
    const list = eventsBySku.get(sku);
    if (list) list.push(e);
    else eventsBySku.set(sku, [e]);
  }

  const onHandBySku = new Map<string, number>();
  for (const s of stockRows) {
    const sku = resolve(s.sku);
    onHandBySku.set(sku, (onHandBySku.get(sku) ?? 0) + s.quantity_on_hand);
  }
  // stock_unverified is a table-level state: until ANY row has a physical
  // count timestamp, every on_hand figure is the receipts-ledger guess.
  const stockAllUncounted = stockRows.length === 0 || stockRows.every((s) => s.last_counted_at === null);

  const inTransitBySku = new Map<string, number>();
  for (const s of shipmentRows) {
    if (s.status === "delivered") continue;
    const sku = resolve(s.sku);
    inTransitBySku.set(sku, (inTransitBySku.get(sku) ?? 0) + s.qty);
  }

  const onOrder = onOrderBySku(openLines, shipmentRows, resolve);

  // --- spikes: late-stage weighted open-deal pipeline -----------------------
  const weightByStage = new Map(stageWeightRows.map((w) => [w.stage_id, w]));
  // "No late-stage allowlist configured yet" is a legitimate state (today only
  // closedwon is late-stage, and closedwon deals are by definition not open) —
  // the engine notes it and runs with zero spike candidates rather than
  // treating configuration lag as an error.
  const openStagesSeen = new Set(openDealRows.map((d) => d.deal_status));
  const anyOpenLateStage = [...openStagesSeen].some((s) => {
    const w = weightByStage.get(s);
    return w !== undefined && w.is_late_stage && w.win_weight > 0;
  });
  if (!anyOpenLateStage) warnings.push("no_late_stage_allowlist_for_open_deals");

  // Candidate spikes per (deal, sku): late-stage open deals with weight > 0,
  // line qty > 0 (defensive — parseLineItems already drops non-positive).
  const spikeCandsBySku = new Map<string, { dealId: string; qty: number; weight: number }[]>();
  for (const d of openDealRows) {
    const w = weightByStage.get(d.deal_status);
    if (w === undefined || !w.is_late_stage || w.win_weight <= 0) continue;
    const perSku = new Map<string, number>();
    for (const item of parseLineItems(d.line_items_raw)) {
      const sku = resolve(item.sku);
      perSku.set(sku, (perSku.get(sku) ?? 0) + item.qty);
    }
    for (const [sku, qty] of perSku) {
      if (qty <= 0) continue;
      const list = spikeCandsBySku.get(sku) ?? [];
      list.push({ dealId: d.hubspot_deal_id, qty, weight: w.win_weight });
      spikeCandsBySku.set(sku, list);
    }
  }

  // --- materials ------------------------------------------------------------
  // Stock is keyed on ns_number, the ONIX item code, which is the same value
  // printed as "Kód položky" on Bamida delivery notes — so a BOM line resolves
  // to a stock card exactly, with no name matching.
  const stockByCode = new Map(materialRows.map((m) => [m.ns_number, m.quantity]));
  const productByFg = new Map(bomProductRows.map((p) => [p.fg_code, p]));
  const componentsByFg = new Map<string, BomComponentRow[]>();
  for (const c of bomComponentRows) {
    // Only materials draw stock. Operations are machine/labour minutes and
    // 'intermediate' rows are produced in-house from other lines on the same BOM
    // (code 311 is printed Mehler) — gating on either would be wrong.
    if (c.line_type !== "material") continue;
    const list = componentsByFg.get(c.fg_code);
    if (list) list.push(c);
    else componentsByFg.set(c.fg_code, [c]);
  }
  const fgBySku = new Map<string, BomSkuMapRow>();
  for (const m of bomSkuMapRows) fgBySku.set(resolve(m.hub_sku), m);

  // --- reconciliation nets (engine warnings + per-SKU flags) ----------------
  const extraFlagsBySku = new Map<string, string[]>();
  const addFlag = (sku: string, flag: string) => {
    const list = extraFlagsBySku.get(sku) ?? [];
    if (!list.includes(flag)) list.push(flag);
    extraFlagsBySku.set(sku, list);
  };

  // (a) closedwon deals whose line items never produced hubspot_deal demand
  // events — demand the ledger failed to capture.
  for (const d of closedWonRows) {
    const items = parseLineItems(d.line_items_raw);
    if (items.length === 0 || demandDealIds.has(d.hubspot_deal_id)) continue;
    warnings.push(`demand_capture_gap:${d.hubspot_deal_id}`);
    for (const item of items) addFlag(resolve(item.sku), "demand_capture_gap");
  }

  // (b) receipts-ledger vs stock-ledger drift per (depot, sku). Informational
  // while all counts are zero; becomes meaningful once receipts/counts land.
  {
    const receiptSum = new Map<string, number>();
    for (const r of receiptRows) {
      const key = `${r.depot}\u0000${resolve(r.sku)}`;
      receiptSum.set(key, (receiptSum.get(key) ?? 0) + r.qty);
    }
    const stockSum = new Map<string, number>();
    for (const s of stockRows) {
      const key = `${s.warehouse_code}\u0000${resolve(s.sku)}`;
      stockSum.set(key, (stockSum.get(key) ?? 0) + s.quantity_on_hand);
    }
    const driftSkus = new Set<string>();
    for (const key of new Set([...receiptSum.keys(), ...stockSum.keys()])) {
      if ((receiptSum.get(key) ?? 0) !== (stockSum.get(key) ?? 0)) {
        driftSkus.add(key.split("\u0000")[1]);
      }
    }
    for (const sku of [...driftSkus].sort()) {
      warnings.push(`stock_drift:${sku}`);
      addFlag(sku, "stock_drift");
    }
  }

  // (c) gating BOM components with no matching stock card, reported ONCE for the
  // whole run rather than per SKU. Bamida exposes 112 material cards to our API
  // account and the BOM references a few they do not (packaging, fasteners);
  // those are marked is_gating=false at seed time, so anything landing here is a
  // genuine drift between the BOM and the feed and wants repairing.
  {
    const missing = new Set<string>();
    for (const c of bomComponentRows) {
      if (c.line_type !== "material" || !c.is_gating) continue;
      if (!stockByCode.has(c.component_code)) missing.add(c.component_code);
    }
    if (missing.size > 0) warnings.push(`bom_join_missing:${[...missing].sort().join(",")}`);
  }

  // --- per-SKU assembly -----------------------------------------------------
  const statusRows: StatusDailyRow[] = [];
  const spikeRegister: SpikeRegisterRow[] = [];
  const writeBacks: ProfileWriteBack[] = [];

  for (const p of computed) {
    const flags: string[] = [];
    const skuEvents = eventsBySku.get(p.sku) ?? [];

    // 1. ADU + CoV (aliased spellings already rolled in via eventsBySku).
    const aduEvents = skuEvents.filter((e) => e.event_date > aduSince);
    const aduComputed = aduEvents.reduce((a, e) => a + e.qty, 0) / ADU_WINDOW_DAYS;
    if (aduEvents.length < THIN_HISTORY_MIN_EVENTS) flags.push("thin_history");
    // CoV weeks end at the current (partial) ISO week; future-dated events past
    // it sit outside the key list and are excluded from CoV (they still count
    // toward ADU — variability is measured over realized time only).
    const cov = covFromWeeklyTotals(weeklyTotals(skuEvents, covWeeks));

    // Manual ADU overrides own the number (DDS&OP); auto rows use tonight's.
    let adu: number;
    if (p.adu_source === "manual") {
      if (p.adu === null) {
        warnings.push(`manual_adu_null:${p.sku}`);
        adu = aduComputed; // defensive fallback — a manual row should carry adu
      } else {
        adu = p.adu;
      }
    } else {
      adu = aduComputed;
    }
    const varFactor =
      p.adu_source === "manual" && p.var_factor !== null ? p.var_factor : varFactorFromCov(cov);

    // 2. DLT (door actuals are global — the table has no per-SKU dimension yet).
    const dlt = dltDaysFor(p, doorDays);

    // 3–6. Flow components.
    const onHand = onHandBySku.get(p.sku) ?? 0;
    if (stockAllUncounted) flags.push("stock_unverified");
    const inTransit = inTransitBySku.get(p.sku) ?? 0;
    const skuOnOrder = onOrder.get(p.sku) ?? 0;
    const firmDemand = skuEvents
      .filter((e) => e.source === "hubspot_deal" && e.event_date > firmSince)
      .reduce((a, e) => a + e.qty, 0);

    // 8 (zones first — the spike guard needs red).
    const zones = computeZones({
      adu,
      dltDays: dlt,
      ltFactor: p.lt_factor,
      varFactor,
      moq: p.moq,
      containerQty: p.container_qty ?? 0,
    });

    // 7. Spikes — guard is BINDING: an unseeded or zero-red buffer would
    // qualify everything (threshold 0.5 × 0 = 0), so qualification is skipped
    // entirely (no register rows — the Slack layer can never storm off them).
    const unseeded = !p.seeded;
    if (unseeded) flags.push("buffers_unseeded");
    const skipSpikes = zones.red === 0 || unseeded;
    let qualified: { dealId: string; qty: number; weight: number }[] = [];
    if (skipSpikes) {
      flags.push("spikes_skipped_no_buffer");
    } else {
      const cands = spikeCandsBySku.get(p.sku) ?? [];
      // Deals carry NO close-date column, so due_date is unknown (null). A null
      // due date is treated as due TODAY — inside any horizon (conservative:
      // better an early spike than an invisible one). The lib's date window is
      // exercised by mapping null → runDate; the register keeps due_date null
      // (we never fabricate a date into persisted data).
      const libCands: SpikeCandidate[] = cands.map((c) => ({
        dealId: c.dealId,
        qty: c.qty,
        dueDate: runDate,
        lateStage: true,
        weight: c.weight,
      }));
      const passed = new Set(
        qualifySpikes(libCands, {
          redZone: zones.red,
          horizonDays: dlt + SPIKE_HORIZON_PAD_DAYS,
          today: now,
        }).map((c) => c.dealId)
      );
      qualified = cands.filter((c) => passed.has(c.dealId));
      for (const q of qualified) {
        spikeRegister.push({
          run_date: runDate,
          deal_id: q.dealId,
          sku: p.sku,
          qty: q.qty,
          due_date: null,
          weight: q.weight,
          qualified: true,
        });
      }
    }
    const spikeLoad = qualified.reduce((a, q) => a + q.qty * q.weight, 0);

    const { nfp, projectedNfp } = computeNFP({
      onHand,
      inTransit,
      onOrder: skuOnOrder,
      firmDemand,
      spikes: qualified.map((q) => ({ qty: q.qty, weight: q.weight, qualified: true })),
    });
    const { zone, actionQty } = zoneFor(nfp, zones);

    // 9. Materials ceiling — can Bamida actually build what the buffer asks for?
    const skuMap = fgBySku.get(p.sku);
    const fgProduct = skuMap ? productByFg.get(skuMap.fg_code) : undefined;
    let maxBuildable: number | null = null;
    let bindingCode: string | null = null;
    let bindingDesc: string | null = null;
    let blocked = false;

    if (!skuMap || !fgProduct) {
      // No BOM for this SKU. Most of the buffered set is accessories and cutting
      // stations that Bamida does not build; silence beats a false red.
      flags.push("materials_unmapped");
    } else {
      const ceiling = materialsCeiling(fgProduct, componentsByFg.get(skuMap.fg_code) ?? [], stockByCode);
      maxBuildable = ceiling.maxBuildable;
      bindingCode = ceiling.bindingComponent;
      bindingDesc = ceiling.bindingDesc;
      if (ceiling.palletSizeUnknown) flags.push("pallet_size_unknown");

      // A mapping that no human has confirmed may INFORM but must never BLOCK.
      // Nothing on a delivery note names a regional Hub SKU, so the SKU→FG link
      // is inference; halting a manufacturing trigger on an inferred parts list
      // is the expensive direction of error, while showing a provisional ceiling
      // next to the number is how the mapping actually gets confirmed.
      if (skuMap.confirmed) {
        blocked = actionQty > 0 && maxBuildable !== null && maxBuildable < actionQty;
      } else {
        flags.push("materials_map_provisional");
      }
    }

    for (const f of extraFlagsBySku.get(p.sku) ?? []) if (!flags.includes(f)) flags.push(f);

    statusRows.push({
      run_date: runDate,
      sku: p.sku,
      on_hand: onHand,
      in_transit: inTransit,
      on_order: skuOnOrder,
      firm_demand: firmDemand,
      qualified_spikes: spikeLoad,
      nfp,
      projected_nfp: projectedNfp,
      red: zones.red,
      yellow_top: zones.yellowTop,
      green_top: zones.greenTop,
      zone,
      // action_qty persists into an int column; NFP can be fractional (numeric
      // firm demand), so round UP — an order that must cover 12.3 units is 13.
      action_qty: Math.ceil(actionQty),
      max_buildable: maxBuildable,
      materials_binding_code: bindingCode,
      materials_binding_desc: bindingDesc,
      blocked_by_materials: blocked,
      flags,
    });

    // Profile write-back: measured stats only while the engine owns them
    // (adu_source='auto'); dlt_days derives from lead-time structure, not ADU
    // ownership, so it recalibrates for manual rows too. updated_at is set
    // explicitly — the table has no touch trigger.
    const wb: ProfileWriteBack = {
      sku: p.sku,
      dlt_days: dlt,
      seeded: true,
      updated_at: now.toISOString(),
    };
    if (p.adu_source === "auto") {
      wb.adu = Math.round(aduComputed * 10_000) / 10_000;
      wb.cov = cov === null ? null : Math.round(cov * 10_000) / 10_000;
      wb.var_factor = varFactorFromCov(cov);
    }
    writeBacks.push(wb);
  }

  if (!opts.dryRun) {
    await data.persistStatus(statusRows);
    await data.persistSpikes(spikeRegister);
    await data.writeBackProfiles(writeBacks);
  }

  return {
    run_date: runDate,
    skus: statusRows.length,
    reds: statusRows.filter((r) => r.zone === "red").length,
    yellows: statusRows.filter((r) => r.zone === "yellow").length,
    greens: statusRows.filter((r) => r.zone === "green").length,
    blocked: statusRows.filter((r) => r.blocked_by_materials).length,
    warnings,
    rows: statusRows,
    spikes: spikeRegister,
  };
}
