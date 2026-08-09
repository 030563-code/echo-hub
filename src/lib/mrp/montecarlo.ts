/**
 * Willemain-style Monte Carlo stockout simulation — PURE, no IO, no ambient
 * dates/randomness. `now` and `rng` are both injected: the same McInput +
 * seeded rng always produces the same McResult, which is what makes this
 * testable and what makes the nightly engine's per-SKU seed
 * (`${runDate}:${sku}`) reproducible across dry-runs and persisted runs.
 *
 * Algorithm (per docs/plans/2026-08-07-mrp-hybrid-trigger.md Task 17):
 *   1. Occurrence — two-state weekly Markov chain (active = ISO-week total >
 *      0) fit on the trailing 52 ISO weeks, with add-one (Laplace) smoothing
 *      on both transition counts so degenerate histories (all-active,
 *      all-inactive) stay strictly inside (0, 1). Initial state for the walk
 *      = the most recent week's activity.
 *   2. Size — empirical positive event quantities from the trailing 365 days
 *      (the caller pre-filters `events` to that window), each draw jittered
 *      × (1 + U(−0.25, 0.25)) and floored at 1 after rounding.
 *   3. Lead time — per iteration, L_i = mfg() + ocean() + customs(): each leg
 *      resamples its empirical actuals array once it has ≥ 10 observations,
 *      else draws Triangular(min, mode, max) with the DDS&OP seed parameters.
 *   4. Demand walk — walk the Markov chain over ceil(L_i / 7) weeks, drawing
 *      one jittered size on each active week, plus Σ Bernoulli(weight_j) ×
 *      qty_j over spikes. Spikes carry no due date (the engine's demand
 *      ledger has no close-date column — see engine.ts's spike-qualification
 *      comment), so each spike is treated as due inside ANY L_i and gets one
 *      Bernoulli trial per iteration.
 *   5. Supply — avail_i = onHand + Σ arrivals landing within L_i (etaDaysFromNow
 *      ≤ L_i); short_i = dem_i > avail_i.
 *   6. Output — pStockout = mean(short); CI = 1.96 × sd(10 batch means) / √10
 *      (95% half-width over batch means, sample sd); dataGrade by local event
 *      count (≥20 → 'A', 5–19 → 'B', <5 → 'C').
 *
 * Nothing is rounded inside this module — callers round for display/persistence.
 */

import { trailingIsoWeeks, weeklyTotals } from "./engine";

// ---------------------------------------------------------------------------
// Seeded RNG
// ---------------------------------------------------------------------------

/** Standard mulberry32 PRNG: fast, deterministic, good enough statistically for simulation (not crypto). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a 32-bit hash — deterministic seed derivation from e.g. `${runDate}:${sku}`. */
export function seedFrom(str: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

// ---------------------------------------------------------------------------
// Public shapes
// ---------------------------------------------------------------------------

export interface McLegSamples {
  mfg: number[];
  ocean: number[];
  customs: number[];
}

/** In-transit / on-order rows with a caller-precomputed days-from-now ETA. */
export interface McArrival {
  qty: number;
  etaDaysFromNow: number;
}

/** Qualified demand spike. Due date is unknown ⇒ always treated as inside L_i. */
export interface McSpike {
  qty: number;
  weight: number;
}

export interface McInput {
  /** Demand events, trailing 365d, region-filtered, alias-resolved. */
  events: { event_date: string; qty: number }[];
  now: Date;
  onHand: number;
  arrivals: McArrival[];
  spikes: McSpike[];
  /** Empirical leg actuals; may be short or empty per leg. */
  legs: McLegSamples;
  iterations?: number;
  /** Injected, seeded — deterministic per (runDate, sku). */
  rng: () => number;
}

export interface McResult {
  /** mean(short_i) over all iterations. */
  pStockout: number;
  /** 95% half-width: 1.96 × sd(10 batch means) / √10. */
  ci: number;
  dataGrade: "A" | "B" | "C";
  /** Local event count used (drives dataGrade). */
  events: number;
}

// ---------------------------------------------------------------------------
// Pure sub-models (exported for unit tests — see the algorithm doc above)
// ---------------------------------------------------------------------------

export interface MarkovFit {
  /** P(active this week | previous week inactive). */
  p01: number;
  /** P(active this week | previous week active). */
  p11: number;
  /** Activity state of the most recent week — the walk's initial state. */
  lastActive: boolean;
}

/**
 * Two-state Markov chain fit over a chronological weekly-totals series
 * (active = total > 0). Add-one (Laplace) smoothing on both transition
 * counts: p = (successes + 1) / (trials + 2), which keeps degenerate
 * histories (all-active, all-inactive) strictly inside (0, 1) instead of
 * collapsing to 0 or 1 on zero observed transitions.
 */
export function fitMarkov(totals: number[]): MarkovFit {
  const active = totals.map((t) => t > 0);
  let n01 = 0;
  let s01 = 0;
  let n11 = 0;
  let s11 = 0;
  for (let i = 1; i < active.length; i++) {
    if (active[i - 1]) {
      n11++;
      if (active[i]) s11++;
    } else {
      n01++;
      if (active[i]) s01++;
    }
  }
  return {
    p01: (s01 + 1) / (n01 + 2),
    p11: (s11 + 1) / (n11 + 2),
    lastActive: active.length > 0 ? active[active.length - 1] : false,
  };
}

/**
 * Inverse-CDF sample from Triangular(min, mode, max) given a uniform variate
 * `u` in [0, 1) — the standard piecewise-quadratic inversion.
 */
export function triangular(min: number, mode: number, max: number, u: number): number {
  const c = (mode - min) / (max - min);
  if (u < c) return min + Math.sqrt(u * (max - min) * (mode - min));
  return max - Math.sqrt((1 - u) * (max - min) * (max - mode));
}

/**
 * Jitter one empirical order-size draw: × (1 + U(−0.25, 0.25)), rounded and
 * floored at 1 (a jittered-down size can never vanish to zero demand).
 */
export function jitterSize(qty: number, rng: () => number): number {
  const jitter = 1 + (rng() * 0.5 - 0.25);
  return Math.max(1, Math.round(qty * jitter));
}

/** Fewer than this many empirical leg observations ⇒ fall back to the Triangular seed. */
const MIN_LEG_ACTUALS = 10;

/** DDS&OP Triangular seeds (min, mode, max) per leg, used below MIN_LEG_ACTUALS observations. */
const LEG_SEEDS: Record<keyof McLegSamples, [number, number, number]> = {
  mfg: [45, 45, 75],
  ocean: [17, 21, 31],
  customs: [5, 9, 21],
};

function sampleLeg(samples: number[], seed: [number, number, number], rng: () => number): number {
  if (samples.length >= MIN_LEG_ACTUALS) return samples[Math.floor(rng() * samples.length)];
  return triangular(seed[0], seed[1], seed[2], rng());
}

// ---------------------------------------------------------------------------
// The simulation
// ---------------------------------------------------------------------------

const DEFAULT_ITERATIONS = 10_000;
const BATCHES = 10;

/**
 * Run the bootstrap simulation. Returns null when there is no local demand
 * history at all (`events.length === 0`) — the shadow board renders that as
 * an em dash rather than a fabricated probability.
 */
export function simulateStockout(input: McInput): McResult | null {
  if (input.events.length === 0) return null;

  const iterations = input.iterations ?? DEFAULT_ITERATIONS;
  const rng = input.rng;

  const weeks = trailingIsoWeeks(input.now, 52);
  const totals = weeklyTotals(input.events, weeks);
  const { p01, p11, lastActive } = fitMarkov(totals);

  const sizes = input.events.filter((e) => e.qty > 0).map((e) => e.qty);

  const shorts: number[] = new Array(iterations);
  for (let i = 0; i < iterations; i++) {
    const L =
      sampleLeg(input.legs.mfg, LEG_SEEDS.mfg, rng) +
      sampleLeg(input.legs.ocean, LEG_SEEDS.ocean, rng) +
      sampleLeg(input.legs.customs, LEG_SEEDS.customs, rng);

    const weeksToWalk = Math.ceil(L / 7);
    let state = lastActive;
    let demand = 0;
    for (let w = 0; w < weeksToWalk; w++) {
      const pActive = state ? p11 : p01;
      const active = rng() < pActive;
      // Defensive: an events-nonempty-but-all-non-positive-qty history (never
      // seen in practice — demand events are always positive) would leave
      // `sizes` empty; an active week then contributes no demand rather than
      // dividing by zero.
      if (active && sizes.length > 0) {
        const size = sizes[Math.floor(rng() * sizes.length)];
        demand += jitterSize(size, rng);
      }
      state = active;
    }

    // Spikes have no due date (null-due-date convention — see engine.ts),
    // so each is realized w.p. its stage weight once per iteration, not
    // per week.
    for (const spike of input.spikes) {
      if (rng() < spike.weight) demand += spike.qty;
    }

    let avail = input.onHand;
    for (const a of input.arrivals) if (a.etaDaysFromNow <= L) avail += a.qty;

    shorts[i] = demand > avail ? 1 : 0;
  }

  const pStockout = shorts.reduce((a, b) => a + b, 0) / iterations;

  // CI via 10 contiguous batch means (any remainder from iterations not
  // divisible by 10 folds into the last batch, so every draw is counted
  // exactly once and no batch is empty for iterations >= 10).
  const batchSize = Math.floor(iterations / BATCHES);
  const batchMeans: number[] = [];
  for (let b = 0; b < BATCHES; b++) {
    const start = b * batchSize;
    const end = b === BATCHES - 1 ? iterations : start + batchSize;
    const slice = shorts.slice(start, end);
    batchMeans.push(slice.reduce((a, x) => a + x, 0) / slice.length);
  }
  const batchMean = batchMeans.reduce((a, b) => a + b, 0) / BATCHES;
  const variance = batchMeans.reduce((a, x) => a + (x - batchMean) ** 2, 0) / (BATCHES - 1);
  const ci = (1.96 * Math.sqrt(variance)) / Math.sqrt(BATCHES);

  const events = input.events.length;
  const dataGrade: "A" | "B" | "C" = events >= 20 ? "A" : events >= 5 ? "B" : "C";

  return { pStockout, ci, dataGrade, events };
}
