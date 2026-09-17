/**
 * What six years of demand history is actually good for.
 *
 * ADU divides by a fixed 180 days and CoV uses 52 ISO weeks, so simply fetching a longer window
 * changes neither number. The deep history earns its place a different way.
 *
 * 🔴 NOT seasonality. That was tested on the full fifteen year history and rejected: across 156
 * month-level tests only 4 came back under p=0.05 where chance alone predicts 7.8, and in a
 * hold-out backtest a seasonal index lost to a flat one twelfth in 13 of 13 series even when it
 * was handed the true annual total for free. The correct seasonal factor is 1.00 in every month
 * for every product, and nothing in this file computes one.
 *
 * What the deep history DOES show is order lumpiness. A single invoice is half or more of the
 * month's units in 31% of H9 months, 44% of H8 months and 62% of Noise Defender months. A buffer
 * sized on an average daily rate is emptied by one ordinary large order, and no amount of
 * variability factor fixes that, because CoV measures week-to-week wobble rather than the size of
 * the biggest single call on stock. So the red zone gets a floor: it must cover a 95th percentile
 * order line. That is a real, measured risk and it is what these functions compute.
 */

export interface DeepDemandRow {
  event_date: string; // 'YYYY-MM-DD'
  organisation: string;
  sku: string;
  qty: number;
}

export interface DeepStats {
  /** Mean daily usage across the whole observed span, for comparison against the 180 day ADU. */
  adu: number;
  /** Coefficient of variation over calendar-month totals; null when under two months. */
  cov: number | null;
  /** 95th percentile of a single order line. The red-zone floor. */
  p95Order: number;
  /** Largest single order line ever seen. Context for the buyer, never a sizing input. */
  maxOrder: number;
  /** Distinct calendar months carrying demand. Under 12 and any variability figure is guesswork. */
  months: number;
  /** How many order lines the percentile was measured over. Under 8 it is not a percentile. */
  orders: number;
  /** First demand date seen, or null when there is none. */
  from: string | null;
}

export const EMPTY_DEEP_STATS: DeepStats = {
  adu: 0,
  cov: null,
  p95Order: 0,
  maxOrder: 0,
  months: 0,
  orders: 0,
  from: null,
};

/**
 * The floor only applies once the history is deep enough for a 95th percentile to mean anything.
 *
 * With fewer than 8 order lines the nearest-rank 95th percentile IS the maximum, so an
 * ungated floor would let one unusual order five years ago permanently inflate a buffer. Twelve
 * months makes sure the orders are spread rather than one burst.
 */
export const LUMPINESS_MIN_ORDERS = 8;
export const LUMPINESS_MIN_MONTHS = 12;

/** Days between two ISO dates, at least 1 so it is never a divide by zero. */
function daysBetween(fromIso: string, toIso: string): number {
  const a = Date.parse(`${fromIso}T00:00:00Z`);
  const b = Date.parse(`${toIso}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 1;
  return Math.max(1, Math.round((b - a) / 86_400_000) + 1);
}

/**
 * Nearest-rank 95th percentile.
 *
 * Nearest-rank rather than interpolated on purpose: an interpolated percentile invents a quantity
 * that was never ordered, and this number goes on to size a physical buffer. With fewer than 20
 * observations the 95th percentile IS the maximum, which is the conservative and honest answer
 * when the history is thin.
 */
export function percentile95(values: number[]): number {
  const clean = values.filter((v) => Number.isFinite(v) && v > 0).sort((a, b) => a - b);
  if (clean.length === 0) return 0;
  const rank = Math.ceil(0.95 * clean.length);
  return clean[Math.min(clean.length, Math.max(1, rank)) - 1];
}

/** Coefficient of variation of a set of period totals. Null when there is nothing to vary. */
export function covOfTotals(totals: number[]): number | null {
  if (totals.length < 2) return null;
  const mean = totals.reduce((a, b) => a + b, 0) / totals.length;
  if (mean <= 0) return null;
  const variance = totals.reduce((a, b) => a + (b - mean) ** 2, 0) / totals.length;
  return Math.sqrt(variance) / mean;
}

/**
 * Deep statistics for one organisation and SKU.
 *
 * `asOf` is the run date. Months with no demand between the first event and `asOf` are counted as
 * zeros in the CoV, because a quiet month is information: a product that sells in bursts with
 * nothing in between is more variable than one that ticks over, and dropping the empty months
 * would hide exactly that.
 */
export function deepStats(rows: DeepDemandRow[], asOf: string): DeepStats {
  if (rows.length === 0) return EMPTY_DEEP_STATS;

  const dates = rows.map((r) => r.event_date).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
  const from = dates[0] ?? null;
  if (!from) return EMPTY_DEEP_STATS;

  const total = rows.reduce((a, r) => a + (Number.isFinite(r.qty) ? r.qty : 0), 0);
  const span = daysBetween(from, asOf);

  const byMonth = new Map<string, number>();
  for (const r of rows) {
    const key = r.event_date.slice(0, 7);
    byMonth.set(key, (byMonth.get(key) ?? 0) + (Number.isFinite(r.qty) ? r.qty : 0));
  }

  // Fill the quiet months between the first event and asOf with zeros.
  const totals: number[] = [];
  const start = new Date(`${from.slice(0, 7)}-01T00:00:00Z`);
  const end = new Date(`${asOf.slice(0, 7)}-01T00:00:00Z`);
  for (let d = start; d <= end; d.setUTCMonth(d.getUTCMonth() + 1)) {
    totals.push(byMonth.get(d.toISOString().slice(0, 7)) ?? 0);
  }

  const qtys = rows.map((r) => r.qty);
  return {
    adu: total / span,
    cov: covOfTotals(totals),
    p95Order: percentile95(qtys),
    maxOrder: qtys.reduce((a, b) => (b > a ? b : a), 0),
    months: byMonth.size,
    orders: qtys.filter((q) => Number.isFinite(q) && q > 0).length,
    from,
  };
}

/**
 * The red zone must cover a 95th percentile order line.
 *
 * Without this, a buffer sized on an average daily rate is emptied by one ordinary large order,
 * and the buyer finds out when the shelf is empty rather than when the order lands. Returns the
 * larger of the DDMRP red zone and the 95th percentile single order, and says which one won so
 * the reason can be shown rather than the number appearing from nowhere.
 */
export function redZoneWithLumpinessFloor(
  red: number,
  stats: Pick<DeepStats, "p95Order" | "orders" | "months">
): { red: number; raised: boolean; gated: boolean } {
  if (stats.orders < LUMPINESS_MIN_ORDERS || stats.months < LUMPINESS_MIN_MONTHS) {
    return { red, raised: false, gated: true };
  }
  const floor = Number.isFinite(stats.p95Order) ? Math.max(0, Math.ceil(stats.p95Order)) : 0;
  if (floor > red) return { red: floor, raised: true, gated: false };
  return { red, raised: false, gated: false };
}
