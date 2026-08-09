/**
 * design.ts — every constant that shapes the "Andy demo" dataset (batch tag
 * 'andy-demo-2026-08-09'). Nothing here is derived; generate.ts is the only
 * place that turns these into rows, and emit-sql.ts is the only place that
 * turns rows into SQL. Two constraints run through the whole file:
 *
 * 1. IDENTIFIABLE + REVERSIBLE. Every row this dataset inserts must carry a
 *    'DEMO-' family marker (source_ref / hubspot_deal_id / po_number /
 *    spot_id) so teardown.sql can delete it by pattern, never by table scan.
 *    Rows this dataset UPDATES (stock, shipment status, buffer profile) are
 *    never marked — the registry table records their prior values instead.
 *
 * 2. THE LEDGER IS REAL, WE ONLY FILL GAPS. REAL_DEMAND is what's already in
 *    mrp_demand_events as of 2026-08-09 (sampled by hand). generate.ts treats
 *    it as a floor to subtract from the modelled monthly target before
 *    inventing synthetic orders — never as something to duplicate.
 */

export const TODAY = "2026-08-09";
export const DEMO_SEED = 20260809;
export const BATCH_TAG = "andy-demo-2026-08-09";

// Historical demand window: nothing synthetic lands on/after 2026-08-01 —
// August-onward "demand" comes from deals (firm demand / spikes), not history.
export const DEMAND_WINDOW_START = "2025-02-01"; // inclusive
export const DEMAND_WINDOW_END = "2026-07-31"; // inclusive

export const REGION_SPLIT = { US: 0.85, CA: 0.15 } as const;

/**
 * Construction-season month index, RAW weights Jan..Dec. generate.ts
 * normalizes these so the 12 values sum to 12 (average weight = 1), so
 * `annual_2026 * normalized[m] / 12` sums to annual_2026 across a full year.
 */
export const MONTH_INDEX_RAW: readonly number[] = [
  0.5, 0.6, 0.85, 1.1, 1.3, 1.4, 1.4, 1.25, 1.1, 0.9, 0.65, 0.45,
];

/** SKU -> product name, shared by PO lines, shipment lines, and deal line items. */
export const PRODUCT_NAMES: Record<string, string> = {
  EBH9NA: "Echo Barrier H9",
  EBH9WNA: "Echo Barrier H9W",
  EBH9XNA: "Echo Barrier H9X",
  EBH9ERNA: "Echo Barrier H9 Ex Rental",
  EBH10NA: "Echo Barrier H10",
  EBH10HERCNA: "Echo Barrier H10 HERC",
  EBH8NA: "Echo Barrier H8",
  V2NA: "Echo Barrier V2",
  CCSNA: "Compact Cutting Station",
  FSCNA: "Full Size Cutting Station",
  BUNNA: "Bungies",
  HKNA: "Hooks",
  EBVFKNA: "Vertical Fitting Kits",
  M1NA: "M1 Mini Gen Set",
};

export const ANNUAL_2026: Record<string, number> = {
  EBH9NA: 5800,
  HKNA: 1500,
  EBH10HERCNA: 1100,
  BUNNA: 950,
  EBH10NA: 750,
  EBH9XNA: 520,
  EBH9ERNA: 200,
  EBVFKNA: 150,
  EBH8NA: 130,
  EBH9WNA: 60,
  M1NA: 45,
  V2NA: 30,
  CCSNA: 15,
  FSCNA: 12,
};

/**
 * SKU processing order. Fixes RNG consumption order for determinism, AND
 * governs the HKNA/EBH9NA date-correlation feature — EBH9NA must be fully
 * generated (all 18 months, with dates) before HKNA is generated, so HKNA can
 * borrow that month's EBH9NA dates.
 */
export const SKU_ORDER: readonly string[] = [
  "EBH9NA",
  "HKNA",
  "EBH10HERCNA",
  "BUNNA",
  "EBH10NA",
  "EBH9XNA",
  "EBH9ERNA",
  "EBVFKNA",
  "EBH8NA",
  "EBH9WNA",
  "M1NA",
  "V2NA",
  "CCSNA",
  "FSCNA",
];

export interface SizeOption {
  size: number;
  weight: number;
}
export interface SizePool {
  pack: number;
  sizes: readonly SizeOption[];
}

export const SIZE_POOLS: Record<string, SizePool> = {
  EBH9NA: {
    pack: 2,
    sizes: [
      { size: 12, weight: 3 },
      { size: 16, weight: 3 },
      { size: 24, weight: 4 },
      { size: 32, weight: 4 },
      { size: 48, weight: 3 },
      { size: 60, weight: 2 },
      { size: 90, weight: 2 },
      { size: 120, weight: 2 },
      { size: 150, weight: 1 },
      { size: 240, weight: 1 },
    ],
  },
  HKNA: {
    pack: 10,
    sizes: [
      { size: 20, weight: 2 },
      { size: 40, weight: 3 },
      { size: 60, weight: 3 },
      { size: 100, weight: 2 },
      { size: 130, weight: 2 },
      { size: 200, weight: 1 },
    ],
  },
  EBH10HERCNA: {
    pack: 5,
    sizes: [
      { size: 30, weight: 2 },
      { size: 65, weight: 3 },
      { size: 130, weight: 3 },
      { size: 260, weight: 1 },
    ],
  },
  BUNNA: {
    pack: 10,
    sizes: [
      { size: 40, weight: 2 },
      { size: 80, weight: 3 },
      { size: 130, weight: 2 },
      { size: 260, weight: 1 },
    ],
  },
  EBH10NA: {
    pack: 5,
    sizes: [
      { size: 15, weight: 2 },
      { size: 30, weight: 4 },
      { size: 60, weight: 3 },
      { size: 120, weight: 2 },
      { size: 280, weight: 1 },
    ],
  },
  EBH9XNA: {
    pack: 4,
    sizes: [
      { size: 8, weight: 2 },
      { size: 16, weight: 3 },
      { size: 24, weight: 3 },
      { size: 40, weight: 2 },
      { size: 80, weight: 1 },
    ],
  },
  EBH9ERNA: {
    pack: 3,
    sizes: [
      { size: 6, weight: 2 },
      { size: 12, weight: 3 },
      { size: 24, weight: 2 },
      { size: 63, weight: 1 },
    ],
  },
  EBVFKNA: {
    pack: 5,
    sizes: [
      { size: 5, weight: 3 },
      { size: 10, weight: 4 },
      { size: 20, weight: 2 },
      { size: 40, weight: 1 },
    ],
  },
  EBH8NA: {
    pack: 4,
    sizes: [
      { size: 4, weight: 2 },
      { size: 8, weight: 3 },
      { size: 12, weight: 2 },
      { size: 24, weight: 1 },
    ],
  },
  EBH9WNA: {
    pack: 4,
    sizes: [
      { size: 4, weight: 3 },
      { size: 8, weight: 3 },
      { size: 12, weight: 2 },
    ],
  },
  M1NA: {
    pack: 2,
    sizes: [
      { size: 2, weight: 3 },
      { size: 4, weight: 3 },
      { size: 6, weight: 2 },
    ],
  },
  V2NA: {
    pack: 1,
    sizes: [
      { size: 1, weight: 3 },
      { size: 2, weight: 3 },
      { size: 4, weight: 2 },
    ],
  },
  CCSNA: {
    pack: 1,
    sizes: [
      { size: 1, weight: 4 },
      { size: 2, weight: 2 },
    ],
  },
  FSCNA: {
    pack: 1,
    sizes: [
      { size: 1, weight: 4 },
      { size: 2, weight: 2 },
    ],
  },
};

/**
 * REAL_DEMAND[sku]['YYYY-MM'] = qty already in mrp_demand_events
 * (region-combined), sampled 2026-08-09. Subtracted from the modelled
 * monthly target before splitting the residual into synthetic orders
 * (floored at 0 — a month whose real demand already exceeds the model gets
 * no synthetic top-up).
 */
export const REAL_DEMAND: Record<string, Record<string, number>> = {
  EBH9NA: {
    "2025-12": 150,
    "2026-02": 150,
    "2026-03": 773,
    "2026-04": 1215,
    "2026-05": 742,
    "2026-06": 207,
    "2026-07": 214,
  },
  EBH10NA: { "2025-01": 30, "2026-02": 280 },
  EBH10HERCNA: { "2026-03": 130, "2026-05": 130, "2026-06": 260, "2026-07": 390 },
  HKNA: { "2026-03": 130, "2026-04": 200, "2026-05": 130, "2026-06": 195, "2026-07": 534 },
  BUNNA: { "2026-06": 260, "2026-07": 548 },
  EBH9XNA: { "2026-05": 16, "2026-07": 371 },
  EBH9ERNA: { "2026-04": 63, "2026-05": 61 },
  EBVFKNA: { "2026-03": 10, "2026-05": 20, "2026-06": 40, "2026-07": 30 },
  EBH8NA: { "2026-02": 48, "2026-04": 2 },
  CCSNA: { "2026-03": 3, "2026-05": 1 },
  FSCNA: { "2026-03": 2 },
};

/**
 * EBH9NA project orders. Subtracted from that month's residual BEFORE the
 * regular pool split runs, then re-added as one explicit order of the full
 * quantity (never itself pool-split or jittered).
 */
export const PROJECT_ORDERS: readonly { sku: string; month: string; qty: number }[] = [
  { sku: "EBH9NA", month: "2025-06", qty: 500 },
  { sku: "EBH9NA", month: "2026-06", qty: 420 },
];

/** Fraction of HKNA orders whose event_date is borrowed from an EBH9NA order in the same month (accessory correlation). */
export const HK_EBH9NA_CORRELATION_RATE = 0.6;

/** Order-size jitter band: candidate size drawn from the pool is scaled by 1 ± JITTER_RATE before rounding to the nearest pack multiple. */
export const JITTER_RATE = 0.2;

// ---------------------------------------------------------------------------
// Firm demand (batch 01) — hubspot_deal-sourced, NOT demo_seed. Mirrors the
// closed-won deal DEMO-D-CW1 below so the ledger shows capture WORKING.
// ---------------------------------------------------------------------------
export const FIRM_DEMAND_DEAL_ID = "DEMO-D-CW1";
export const FIRM_DEMAND_REGION = "US" as const;
export const FIRM_DEMAND_EVENTS: readonly { sku: string; qty: number; event_date: string }[] = [
  { sku: "EBH9NA", qty: 96, event_date: "2026-08-06" },
  { sku: "EBH10HERCNA", qty: 60, event_date: "2026-08-06" },
];

// ---------------------------------------------------------------------------
// Stage weight (batch 02)
// ---------------------------------------------------------------------------
export const STAGE_WEIGHT_ROW = {
  stage_id: "demo_late_stage",
  stage_label: "DEMO Contract Sent",
  win_weight: 0.35,
  is_late_stage: true,
  seeded_manually: true,
} as const;

// ---------------------------------------------------------------------------
// Lead-time actuals (batch 03) — 12 samples per leg, spot_id='DEMO'.
// ---------------------------------------------------------------------------
export const LEAD_TIME_SPOT_ID = "DEMO";
/** observed_at walks back one month per array index, starting at this date (index 0). */
export const LEAD_TIME_OBSERVED_FROM = "2026-08-01";
export const LEAD_TIME_SAMPLES: Record<"mfg" | "ocean" | "customs" | "door", readonly number[]> = {
  mfg: [40, 44, 47, 49, 51, 52, 53, 55, 58, 61, 65, 70],
  ocean: [18, 19, 20, 21, 21, 22, 22, 23, 25, 27, 29, 30],
  customs: [4, 5, 6, 7, 7, 8, 9, 10, 11, 12, 13, 14],
  door: [26, 28, 30, 31, 32, 33, 34, 35, 37, 39, 42, 44],
};

// ---------------------------------------------------------------------------
// Deals (batch 04)
// ---------------------------------------------------------------------------
export const UNIT_PRICE: Record<string, number> = {
  EBH9NA: 250,
  EBH10NA: 305,
  EBH10HERCNA: 320,
  HKNA: 12,
  EBH8NA: 210,
  EBH9XNA: 380,
};

export const PIPELINE_NAME = "NA Depot Sales";

export const DEPOT_META: Record<string, { currency: string; xeroOrg: string; region: "US" | "CA" }> = {
  "US-BAL": { currency: "USD", xeroOrg: "USA", region: "US" },
  "US-SBD": { currency: "USD", xeroOrg: "USA", region: "US" },
  "CA-HAM": { currency: "CAD", xeroOrg: "CANADA", region: "CA" },
};

/**
 * xero_item_code = XERO_CODE_BASE[sku] + XERO_DEPOT_SUFFIX[depot]. Only the
 * EBH9NA @ US-BAL combination ('H9BAL') is given verbatim by the source spec
 * (it's the worked example); the rest follow the same pattern for internal
 * consistency — an inferred convention, not a confirmed live mapping.
 */
export const XERO_CODE_BASE: Record<string, string> = {
  EBH9NA: "H9",
  EBH9WNA: "H9W",
  EBH9XNA: "H9X",
  EBH9ERNA: "H9ER",
  EBH10NA: "H10",
  EBH10HERCNA: "H10HERC",
  EBH8NA: "H8",
  HKNA: "HK",
  BUNNA: "BUN",
  EBVFKNA: "VFK",
  M1NA: "M1",
  V2NA: "V2",
  CCSNA: "CCS",
  FSCNA: "FSC",
};
export const XERO_DEPOT_SUFFIX: Record<string, string> = {
  "US-BAL": "BAL",
  "US-SBD": "SBD",
  "CA-HAM": "HAM",
};

export interface DealLineSpec {
  sku: string;
  qty: number;
}
export interface DealSpec {
  id: string;
  name: string;
  depot: string;
  status: string;
  lines: readonly DealLineSpec[];
  /** Overrides the computed qty*unit_price sum when the spec gives an explicit header amount. */
  amountOverride?: number;
}

export const OPEN_PIPELINE_DEALS: readonly DealSpec[] = [
  {
    id: "DEMO-D-OP1",
    name: "Riverside Medical Center — HVAC screening",
    depot: "US-SBD",
    status: "Quote Created",
    lines: [{ sku: "EBH9NA", qty: 120 }],
  },
  {
    id: "DEMO-D-OP2",
    name: "Boston Logan T3 works",
    depot: "US-BAL",
    status: "Quote Created",
    lines: [
      { sku: "EBH9NA", qty: 60 },
      { sku: "HKNA", qty: 40 },
    ],
  },
  {
    id: "DEMO-D-OP3",
    name: "Hamilton LRT enabling works",
    depot: "CA-HAM",
    status: "Quote Created",
    lines: [{ sku: "EBH10NA", qty: 45 }],
  },
  {
    id: "DEMO-D-OP4",
    name: "Nashville data-center build",
    depot: "US-BAL",
    status: "Quote Created",
    lines: [{ sku: "EBH10HERCNA", qty: 90 }],
  },
  {
    id: "DEMO-D-OP5",
    name: "Jersey City school retrofit",
    depot: "US-BAL",
    status: "Quote Created",
    lines: [{ sku: "EBH8NA", qty: 24 }],
  },
  {
    id: "DEMO-D-OP6",
    name: "Calgary ring-road",
    depot: "CA-HAM",
    status: "Quote Created",
    lines: [{ sku: "EBH9XNA", qty: 32 }],
  },
];

export const LATE_STAGE_DEALS: readonly DealSpec[] = [
  {
    id: "DEMO-D-SP1",
    name: "I-95 Corridor Phase 2 — noise mitigation",
    depot: "US-BAL",
    status: "demo_late_stage",
    lines: [
      { sku: "EBH9NA", qty: 800 },
      { sku: "HKNA", qty: 400 },
    ],
    amountOverride: 208800,
  },
  {
    id: "DEMO-D-SP2",
    name: "Toronto Transit Extension — Aecon JV",
    depot: "CA-HAM",
    status: "demo_late_stage",
    lines: [
      { sku: "EBH9NA", qty: 320 },
      { sku: "EBH10NA", qty: 180 },
    ],
    amountOverride: 143000,
  },
];

export const CLOSED_WON_DEAL: DealSpec = {
  id: FIRM_DEMAND_DEAL_ID,
  name: "Denver Airport concourse — won",
  depot: "US-BAL",
  status: "closedwon",
  lines: [
    { sku: "EBH9NA", qty: 96 },
    { sku: "EBH10HERCNA", qty: 60 },
  ],
};

// ---------------------------------------------------------------------------
// POs (batch 05) — source='hub', notes start 'DEMO seed —'.
// ---------------------------------------------------------------------------
export const OPENING_STOCK_RECEIVED_AT = "2026-07-15T00:00:00Z";
export const OPENING_STOCK_CREATED_AT = "2026-07-01T00:00:00Z";
export const OPEN_PO_CREATED_AT = "2026-07-20T00:00:00Z";

export const OPENING_STOCK_POS: readonly { po_number: string; depot: string }[] = [
  { po_number: "DEMO-EBUS26090", depot: "US-BAL" },
  { po_number: "DEMO-EBUS26091", depot: "US-SBD" },
  { po_number: "DEMO-EBUS26092", depot: "CA-HAM" },
];

export const OPEN_POS: readonly { po_number: string; depot: string; status: string; lines: readonly DealLineSpec[] }[] = [
  {
    po_number: "DEMO-EBUS26101",
    depot: "US-BAL",
    status: "approved",
    lines: [
      { sku: "HKNA", qty: 260 },
      { sku: "EBH10NA", qty: 280 },
    ],
  },
  {
    po_number: "DEMO-EBUS26102",
    depot: "US-BAL",
    status: "shipped",
    lines: [{ sku: "EBH9NA", qty: 560 }],
  },
];

// ---------------------------------------------------------------------------
// Shipments (batch 06)
// ---------------------------------------------------------------------------
export interface DemoShipmentSpec {
  spot_id: string;
  container_ref: string;
  depot: string;
  status: string;
  shipped_at: string;
  eta: string;
  po_number: string | null;
  lines: readonly DealLineSpec[];
}

export const DEMO_SHIPMENTS: readonly DemoShipmentSpec[] = [
  {
    spot_id: "DEMO-SPOT-01",
    container_ref: "DEMO-CNT-01",
    depot: "US-BAL",
    status: "on_water",
    shipped_at: "2026-07-28",
    eta: "2026-08-27",
    po_number: "DEMO-EBUS26102",
    lines: [{ sku: "EBH9NA", qty: 560 }],
  },
  {
    spot_id: "DEMO-SPOT-02",
    container_ref: "DEMO-CNT-02",
    depot: "US-BAL",
    status: "on_water",
    shipped_at: "2026-08-02",
    eta: "2026-09-03",
    po_number: null,
    lines: [
      { sku: "EBH10HERCNA", qty: 280 },
      { sku: "EBVFKNA", qty: 40 },
    ],
  },
];

// ---------------------------------------------------------------------------
// Stock (batch 07) — UPDATE existing rows only.
// ---------------------------------------------------------------------------
export const STOCK_LAST_COUNTED_AT = "2026-08-07T09:00:00Z";

export const STOCK: Record<string, Record<string, number>> = {
  "US-BAL": {
    EBH9NA: 1200,
    HKNA: 480,
    BUNNA: 420,
    EBH10HERCNA: 340,
    EBH10NA: 60,
    EBH9XNA: 170,
    EBVFKNA: 12,
    EBH8NA: 90,
    EBH9WNA: 30,
    M1NA: 20,
    V2NA: 15,
    CCSNA: 6,
    FSCNA: 5,
  },
  "US-SBD": {
    EBH9NA: 420,
    EBH10NA: 40,
    EBH9ERNA: 70,
    EBH9XNA: 60,
    EBH8NA: 35,
  },
  "CA-HAM": {
    EBH9NA: 260,
    EBH10NA: 35,
    HKNA: 130,
    BUNNA: 90,
    EBH10HERCNA: 110,
  },
};

// ---------------------------------------------------------------------------
// Buffer profiles (batch 08) — UPDATE only; adu/cov/var_factor/dlt_days/
// seeded belong to the engine and are never touched here.
// ---------------------------------------------------------------------------
export const PROFILE_CONTAINER_QTY: Record<string, number> = {
  EBH9NA: 560,
  EBH9XNA: 400,
  EBH10HERCNA: 280,
  EBH10NA: 280,
  EBH8NA: 560,
  EBH9ERNA: 560,
  EBH9WNA: 560,
};

export const PROFILE_CBM_PER_UNIT: Record<string, number> = {
  EBH9NA: 0.118,
  EBH9ERNA: 0.118,
  EBH9WNA: 0.13,
  EBH9XNA: 0.165,
  EBH10NA: 0.235,
  EBH10HERCNA: 0.235,
  EBH8NA: 0.09,
  HKNA: 0.012,
  BUNNA: 0.008,
  EBVFKNA: 0.05,
  M1NA: 0.4,
  V2NA: 0.35,
  CCSNA: 0.6,
  FSCNA: 0.6,
};

export const PROFILE_MOQ: Record<string, number> = {
  EBH9NA: 70,
  EBH9XNA: 40,
  EBH10NA: 30,
  EBH10HERCNA: 30,
  EBH8NA: 70,
  EBH9ERNA: 30,
  EBH9WNA: 30,
  HKNA: 100,
  BUNNA: 100,
  EBVFKNA: 25,
};
