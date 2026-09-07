/**
 * Head-to-head historical inventory simulation — zone-crossing vs Monte Carlo
 * triggering, replayed over the SAME real demand (plan Task 19 evidence).
 * PURE: no IO, no ambient dates/rng; every input is injected.
 *
 * Both policies share the SAME weekly loop (`runPolicy`); `decide(ctx)` —
 * order TIMING only — is the sole difference. Order SIZE is the identical
 * (greenTop − NFP) formula either way, which isolates the variable under
 * test: does triggering on probability beat triggering on zone crossing.
 *
 * Simplification (deliberate): NFP here = onHand + onOrder only. A
 * historical replay has no in-transit/firm-demand/spike pipeline to run
 * back through, so those extra DDMRP NFP components (present in the live
 * engine — see buffers.ts's computeNFP) are not modelled.
 */

import { covFromWeeklyTotals, trailingIsoWeeks, weeklyTotals } from "./engine";
import { computeZones, type Zones } from "./buffers";
import { simulateStockout, type McLegSamples } from "./montecarlo";
import type { HistEvent } from "./backtest";

export type { HistEvent };

export interface PolicyResult {
  label: string;
  orders: number; // count of replenishment orders raised
  unitsOrdered: number;
  stockoutWeeks: number; // weeks that ended with unmet demand
  demandMet: number;
  demandTotal: number; // fill rate = met/total
  avgOnHand: number; // mean weekly closing on-hand (the capital cost proxy)
  peakOnHand: number;
}

export interface SimConfig {
  events: HistEvent[];
  startDate: Date;
  endDate: Date;
  leadDays: number; // 79
  openingStock: number;
  /** zones policy inputs; ADU/CoV are recomputed each week from trailing history. */
  ltFactor: number;
  varFactorFor: (cov: number | null) => number;
  moq: number;
  containerQty: number;
  /**
   * Empirical leg actuals for the MC policy's simulateStockout call. Not
   * listed on the plan's SimConfig sketch, but simulateStockout requires it —
   * an evident spec gap, filled minimally (see the Task 18/19 report).
   */
  legs: McLegSamples;
  /** For the MC policy — consumed as a stream across the whole run (not reseeded per week). */
  rng: () => number;
}

const MS_PER_DAY = 86_400_000;

function eventTime(e: HistEvent): number {
  return new Date(`${e.event_date}T00:00:00Z`).getTime();
}

interface DecideCtx {
  weekDate: Date;
  /** Trailing-365-day history strictly before this week — the MC policy's simulateStockout events. */
  history365: HistEvent[];
  onHand: number;
  onOrder: number;
  nfp: number;
  zones: Zones;
}

type Decide = (ctx: DecideCtx) => number;

function runPolicy(c: SimConfig, label: string, decide: Decide): PolicyResult {
  let onHand = c.openingStock;
  const pending: { arrivalWeek: number; qty: number }[] = [];
  const arrivalOffsetWeeks = Math.ceil(c.leadDays / 7);

  let orders = 0;
  let unitsOrdered = 0;
  let stockoutWeeks = 0;
  let demandMet = 0;
  let demandTotal = 0;
  const onHandSamples: number[] = [];

  let weekIndex = 0;
  for (let t = c.startDate.getTime(); t <= c.endDate.getTime(); t += 7 * MS_PER_DAY, weekIndex++) {
    const weekDate = new Date(t);
    const weekEnd = t + 7 * MS_PER_DAY;

    // 1. Receive any orders whose arrival week has come.
    for (let i = pending.length - 1; i >= 0; i--) {
      if (pending[i].arrivalWeek <= weekIndex) {
        onHand += pending[i].qty;
        pending.splice(i, 1);
      }
    }

    // 2. Demand for the week = actual events in that week. Fulfil what we
    // can from on-hand; shortfall counts toward stockoutWeeks and reduces
    // demandMet.
    const weekDemand = c.events.reduce((a, e) => {
      const et = eventTime(e);
      return et >= t && et < weekEnd ? a + e.qty : a;
    }, 0);
    demandTotal += weekDemand;
    demandMet += Math.min(weekDemand, onHand);
    if (weekDemand > onHand) stockoutWeeks++;
    onHand = Math.max(0, onHand - weekDemand);
    onHandSamples.push(onHand);

    // 3. Recompute ADU/CoV from the trailing 365 days STRICTLY BEFORE this
    // week (mirrors the live engine, which never sees the future) — reusing
    // engine.ts/buffers.ts math rather than duplicating it.
    const beforeWeek = c.events.filter((e) => eventTime(e) < t);
    const since365 = t - 365 * MS_PER_DAY;
    const history365 = beforeWeek.filter((e) => eventTime(e) > since365);
    const adu = history365.reduce((a, e) => a + e.qty, 0) / 365;
    const cov = covFromWeeklyTotals(weeklyTotals(beforeWeek, trailingIsoWeeks(weekDate, 52)));
    const varFactor = c.varFactorFor(cov);
    const zones = computeZones({
      adu,
      dltDays: c.leadDays,
      ltFactor: c.ltFactor,
      varFactor,
      moq: c.moq,
      containerQty: c.containerQty,
    });

    // 4. NFP = onHand + onOrder (no in-transit/firm-demand/spikes in a
    // historical sim — see the header comment).
    const onOrder = pending.reduce((a, p) => a + p.qty, 0);
    const nfp = onHand + onOrder;

    // 5. decide → order quantity. Order SIZE is the same formula either way;
    // only the trigger condition differs between callers.
    const rawOrderQty = decide({ weekDate, history365, onHand, onOrder, nfp, zones });

    // 6. Clamp to >= 0; skip zero orders.
    const orderQty = Math.max(0, rawOrderQty);
    if (orderQty > 0) {
      pending.push({ arrivalWeek: weekIndex + arrivalOffsetWeeks, qty: orderQty });
      orders++;
      unitsOrdered += orderQty;
    }
  }

  const avgOnHand =
    onHandSamples.length === 0 ? 0 : onHandSamples.reduce((a, b) => a + b, 0) / onHandSamples.length;
  const peakOnHand = onHandSamples.length === 0 ? 0 : Math.max(...onHandSamples);

  return { label, orders, unitsOrdered, stockoutWeeks, demandMet, demandTotal, avgOnHand, peakOnHand };
}

/** ZONE policy: order up to green-top whenever NFP falls to yellow-top or below. */
export function simulateZonePolicy(c: SimConfig): PolicyResult {
  return runPolicy(c, "zone", (ctx) => (ctx.nfp <= ctx.zones.yellowTop ? ctx.zones.greenTop - ctx.nfp : 0));
}

/**
 * MC policy: order up to green-top whenever the bootstrap stockout
 * probability exceeds `threshold`. A week with no usable local history
 * (simulateStockout returns null) is treated as no assessed risk — the same
 * "no signal" convention the live shadow board uses — so it never MC-triggers.
 */
export function simulateMcPolicy(c: SimConfig, threshold: number): PolicyResult {
  return runPolicy(c, `mc:${threshold}`, (ctx) => {
    const mc = simulateStockout({
      events: ctx.history365,
      now: ctx.weekDate,
      onHand: ctx.nfp,
      arrivals: [],
      spikes: [],
      legs: c.legs,
      iterations: 1000,
      rng: c.rng,
    });
    const p = mc === null ? 0 : mc.pStockout;
    return p > threshold ? ctx.zones.greenTop - ctx.nfp : 0;
  });
}
