/**
 * Backtest scoring — Monte Carlo calibration evidence against real history
 * (plan Task 18). PURE: no IO, no ambient dates/rng; callers (see
 * scripts/backtest-mc-uk.ts) assemble Trial[] by running simulateStockout
 * themselves against real demand and score the result here.
 *
 * Calibration method (why — the important design decision):
 * the UK ledger has no historical STOCK POSITIONS, and inventing one would
 * make the result meaningless. So each weekly decision point is swept across
 * a RANGE of hypothetical starting positions (deciles of the trailing
 * lead-time demand) instead, and every (week, position) pair is scored as one
 * independent trial: predicted = simulateStockout's pStockout at that
 * position; actual = whether real demand over the following lead time
 * exceeded it. A well-calibrated model has observedRate ≈ meanPredicted in
 * every probability-decile bucket.
 */

export interface HistEvent {
  event_date: string;
  qty: number;
}

/** One (predicted probability, actual outcome) pair from one simulated decision point. */
export interface Trial {
  week: string;
  predicted: number;
  stockedOut: boolean;
  position: number;
}

export interface CalibrationBucket {
  loPct: number; // decile bounds in PERCENT, e.g. 30..40
  hiPct: number;
  n: number; // trials in bucket
  meanPredicted: number; // mean predicted p (fraction 0..1) in bucket
  observedRate: number; // fraction that actually stocked out
}

const MS_PER_DAY = 86_400_000;
const DECILES = 10;

/**
 * Actual demand in the `days` following `from` — exclusive of `from`,
 * inclusive of the window end (from < event_date <= from + days).
 */
export function demandOver(events: HistEvent[], from: Date, days: number): number {
  const start = from.getTime();
  const end = start + days * MS_PER_DAY;
  let total = 0;
  for (const e of events) {
    const t = new Date(`${e.event_date}T00:00:00Z`).getTime();
    if (t > start && t <= end) total += e.qty;
  }
  return total;
}

/**
 * Buckets trials by predicted probability into deciles (0-10%, 10-20%, …,
 * 90-100%), drops empty buckets, and reports mean predicted vs observed rate
 * per bucket. A predicted value of exactly 1.0 lands in the top bucket rather
 * than overflowing an 11th one.
 */
export function calibrate(trials: Trial[]): CalibrationBucket[] {
  const buckets = Array.from({ length: DECILES }, () => ({ n: 0, sumPredicted: 0, sumActual: 0 }));
  for (const t of trials) {
    const idx = Math.min(DECILES - 1, Math.max(0, Math.floor(t.predicted * DECILES)));
    const b = buckets[idx];
    b.n++;
    b.sumPredicted += t.predicted;
    b.sumActual += t.stockedOut ? 1 : 0;
  }
  const out: CalibrationBucket[] = [];
  buckets.forEach((b, idx) => {
    if (b.n === 0) return;
    out.push({
      loPct: idx * (100 / DECILES),
      hiPct: (idx + 1) * (100 / DECILES),
      n: b.n,
      meanPredicted: b.sumPredicted / b.n,
      observedRate: b.sumActual / b.n,
    });
  });
  return out;
}

/** Brier score = mean((predicted - actual)^2). Lower is better; 0.25 = coin flip. */
export function brierScore(trials: Trial[]): number {
  if (trials.length === 0) return 0;
  const sum = trials.reduce((a, t) => a + (t.predicted - (t.stockedOut ? 1 : 0)) ** 2, 0);
  return sum / trials.length;
}
