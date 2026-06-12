"use server";

import { createAdminClient } from "@/lib/supabase/admin";
import { hasCapability } from "@/lib/authz";
import type { MRPRow } from "@/lib/erp-types";

// Allowlist of valid SKUs — guards untrusted JSONB line_items_raw data
// NA-suffix = North America-facing SKUs; SK-suffix = SRO / Slovakia-internal SKUs
const VALID_SKUS = new Set([
  // NA — standard manufactured products shipped to North America
  "EBH9NA","EBH9WNA","EBH9XNA","EBH9ERNA","EBH10NA","EBH10HERCNA",
  "EBH8NA","V2NA","CCSNA","FSCNA","BUNNA","HKNA","EBVFKNA","M1NA",
  // SK — SRO internal / direct-sale codes
  "EBH9SK","EBH10SK","EBH9WSK","EBH9X21SK","EBH9X15SK",   // Standard
  "EBH8SK","EBHT35SK",                                      // Triples
  "EBH9JAPSK","EBH10JAPSK","EBH10HBSK",                    // Customer Specific
  "EBH9MINISK","EBH8MINISK",                                // Samples
  "HERASSK","NDS200SK","NDTSK",                             // Noise Defender
  "CSFSSR","CSCSSR","CSPTSK","CSPWSK","V2SK","M1SK","GENEXTSK", // Equipment
]);

// Minimum safety stock floor per SKU when demand history is too sparse (< 4 data points).
// NA core products get a floor to prevent zero-stock risk; SRO specialty SKUs default to 0.
const SAFETY_STOCK_FLOOR: Record<string, number> = {
  EBH9NA: 20, EBH9WNA: 10, EBH9XNA: 10, EBH9ERNA: 10,
  EBH10NA: 15, EBH10HERCNA: 10, EBH8NA: 10, V2NA: 10,
  CCSNA: 5, FSCNA: 5, BUNNA: 20, HKNA: 20, EBVFKNA: 10, M1NA: 5,
};
const DEFAULT_FLOOR = 0; // SRO-internal SKUs — no floor until Dave provides minimums

/**
 * Computes statistical safety stock per SKU from closed won deal history.
 * Formula: Safety Stock = Z × σ × √L
 *   Z = 1.65 (95% service level)
 *   σ = std dev of weekly demand (units) over last 52 weeks
 *   L = lead time in weeks (90 days ÷ 7 ≈ 12.86 weeks)
 *
 * Falls back to SAFETY_STOCK_FLOOR when n < 4 weeks of data.
 */
async function computeStatisticalSafetyStock(
  supabase: ReturnType<typeof createAdminClient>
): Promise<Record<string, number>> {
  const Z = 1.65;
  const L_weeks = 90 / 7; // ~12.857 weeks
  const MIN_DATA_POINTS = 4;

  const fiftyTwoWeeksAgo = new Date(Date.now() - 52 * 7 * 86400000).toISOString();

  const { data: closedDeals, error } = await supabase
    .from("deals_registry")
    .select("line_items_raw, updated_at")
    .ilike("deal_status", "%closedwon%")
    .gte("updated_at", fiftyTwoWeeksAgo);

  // If query fails, return floors so MRP still renders
  if (error || !closedDeals?.length) {
    return Object.fromEntries(
      [...VALID_SKUS].map((sku) => [sku, SAFETY_STOCK_FLOOR[sku] ?? DEFAULT_FLOOR])
    );
  }

  // Bucket demand by SKU → ISO week key (e.g. "2025-W12")
  const weeklyDemand = new Map<string, Map<string, number>>();

  for (const deal of closedDeals) {
    const weekKey = getISOWeekKey(deal.updated_at);
    for (const item of (deal.line_items_raw ?? []) as { sku?: string; quantity?: number }[]) {
      if (!item.sku || !item.quantity || !VALID_SKUS.has(item.sku)) continue;
      if (!weeklyDemand.has(item.sku)) weeklyDemand.set(item.sku, new Map());
      const skuWeeks = weeklyDemand.get(item.sku)!;
      skuWeeks.set(weekKey, (skuWeeks.get(weekKey) ?? 0) + item.quantity);
    }
  }

  const result: Record<string, number> = {};

  for (const sku of VALID_SKUS) {
    const floor = SAFETY_STOCK_FLOOR[sku] ?? DEFAULT_FLOOR;
    const weekMap = weeklyDemand.get(sku);

    if (!weekMap || weekMap.size < MIN_DATA_POINTS) {
      result[sku] = floor;
      continue;
    }

    const values = [...weekMap.values()];
    const mean = values.reduce((s, v) => s + v, 0) / values.length;
    const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / (values.length - 1);
    const stdDev = Math.sqrt(variance);

    const computed = Math.ceil(Z * stdDev * Math.sqrt(L_weeks));
    result[sku] = Math.max(computed, floor);
  }

  return result;
}

/** Returns an ISO week string like "2025-W12" from an ISO date string. */
function getISOWeekKey(isoDate: string): string {
  const d = new Date(isoDate);
  // Thursday in current week determines the year
  const thursday = new Date(d);
  thursday.setDate(d.getDate() - ((d.getDay() + 6) % 7) + 3);
  const yearStart = new Date(thursday.getFullYear(), 0, 1);
  const week = Math.ceil(((thursday.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${thursday.getFullYear()}-W${String(week).padStart(2, "0")}`;
}

// Manufacturing + shipping lead time in days (static until Dave provides dynamic value)
const DEFAULT_LEAD_TIME_DAYS = 90;

export async function calculateMRP(): Promise<MRPRow[]> {
  // Capability gate (defense in depth — the /mrp layout also gates the route).
  if (!(await hasCapability("mrp.view"))) {
    throw new Error("Forbidden: missing mrp.view capability");
  }

  // Service-role client: the MRP must compute demand across ALL deals/stock, not
  // the caller's region-scoped slice. Authorized by the mrp.view gate above.
  const supabase = createAdminClient();

  // 0. Statistical safety stock — computed from closed won demand history
  const safetyStockMap = await computeStatisticalSafetyStock(supabase);

  // 1. In Stock — warehouse_stock_levels (critical — fail hard if unavailable)
  const { data: stockData, error: stockErr } = await supabase
    .from("warehouse_stock_levels")
    .select("sku, product_name, quantity_on_hand");
  if (stockErr) throw new Error("Failed to load warehouse stock");

  // 2. In Transit — shipment_contents (not yet delivered)
  const { data: transitData, error: transitErr } = await supabase
    .from("shipment_contents")
    .select("sku, qty")
    .not("status", "eq", "delivered");
  if (transitErr) throw new Error("Failed to load shipment data");

  // 3. On Order — purchase_orders with active manufacturing/stock statuses
  const { data: poData, error: poErr } = await supabase
    .from("purchase_orders")
    .select("id, status, lines:purchase_order_lines(sku, quantity)")
    .in("status", ["requested", "approved", "sro_evaluating", "fulfilling_from_stock", "in_manufacturing"]);
  if (poErr) throw new Error("Failed to load purchase orders");

  // 4. Pipeline Demand — deals_registry (open/active deals with line items)
  const { data: dealsData, error: dealsErr } = await supabase
    .from("deals_registry")
    .select("line_items_raw, deal_probability")
    .not("deal_status", "ilike", "%closed%");
  if (dealsErr) throw new Error("Failed to load pipeline deals");

  // 5. Historical sales for daily run rate — deals closed won in last 90 days
  const ninetyDaysAgo = new Date(Date.now() - 90 * 86400000).toISOString();
  const { data: closedDeals, error: closedErr } = await supabase
    .from("deals_registry")
    .select("line_items_raw")
    .ilike("deal_status", "%closedwon%")
    .gte("updated_at", ninetyDaysAgo);
  if (closedErr) throw new Error("Failed to load closed deals");

  // --- Aggregate by SKU ---
  const skuMap = new Map<string, { product_name: string | null; in_stock: number }>();
  (stockData ?? []).forEach((row) => {
    skuMap.set(row.sku, { product_name: row.product_name, in_stock: row.quantity_on_hand });
  });

  // In transit
  const inTransit = new Map<string, number>();
  (transitData ?? []).forEach(({ sku, qty }) => {
    inTransit.set(sku, (inTransit.get(sku) ?? 0) + qty);
  });

  // On order
  const onOrder = new Map<string, number>();
  (poData ?? []).forEach((po) => {
    (po.lines ?? []).forEach(({ sku, quantity }: { sku: string; quantity: number }) => {
      onOrder.set(sku, (onOrder.get(sku) ?? 0) + quantity);
    });
  });

  // Pipeline demand
  const pipelineDemand = new Map<string, number>();
  (dealsData ?? []).forEach(({ line_items_raw, deal_probability }) => {
    const prob = (deal_probability ?? 0) > 1 ? (deal_probability ?? 0) / 100 : (deal_probability ?? 0);
    (line_items_raw ?? []).forEach((item: { sku?: string; quantity?: number }) => {
      if (!item.sku || !item.quantity || !VALID_SKUS.has(item.sku)) return;
      const contribution = item.quantity * prob;
      pipelineDemand.set(item.sku, (pipelineDemand.get(item.sku) ?? 0) + contribution);
    });
  });

  // Daily run rate from closed won last 90 days
  const closedQty = new Map<string, number>();
  (closedDeals ?? []).forEach(({ line_items_raw }) => {
    (line_items_raw ?? []).forEach((item: { sku?: string; quantity?: number }) => {
      if (!item.sku || !item.quantity || !VALID_SKUS.has(item.sku)) return;
      closedQty.set(item.sku, (closedQty.get(item.sku) ?? 0) + item.quantity);
    });
  });

  // Build rows for all warehouse SKUs
  const rows: MRPRow[] = [];
  for (const [sku, { product_name, in_stock }] of skuMap) {
    const transit = inTransit.get(sku) ?? 0;
    const ordered = onOrder.get(sku) ?? 0;
    const cip = in_stock + transit + ordered;

    const pipeline = pipelineDemand.get(sku) ?? 0;
    const dailyRunRate = (closedQty.get(sku) ?? 0) / 90;
    const leadTimeDemand = dailyRunRate * DEFAULT_LEAD_TIME_DAYS + pipeline;
    const safety = safetyStockMap[sku] ?? 0;
    const threshold = leadTimeDemand + safety;

    let status: "green" | "yellow" | "red";
    if (cip <= threshold * 0.5) status = "red";
    else if (cip <= threshold) status = "yellow";
    else status = "green";

    rows.push({
      sku,
      product_name,
      in_stock,
      in_transit: transit,
      on_order: ordered,
      cip,
      pipeline_demand: Math.round(pipeline),
      daily_run_rate: Math.round(dailyRunRate * 100) / 100,
      lead_time_days: DEFAULT_LEAD_TIME_DAYS,
      lead_time_demand: Math.round(leadTimeDemand),
      safety_stock: safety,
      trigger_threshold: Math.round(threshold),
      status,
    });
  }

  return rows.sort((a, b) => {
    const order = { red: 0, yellow: 1, green: 2 };
    return order[a.status] - order[b.status];
  });
}
