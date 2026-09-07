import { describe, it, expect } from 'vitest'
import { demandOver, calibrate, brierScore, type Trial, type HistEvent } from '@/lib/mrp/backtest'
import { mulberry32 } from '@/lib/mrp/montecarlo'
import {
  simulateZonePolicy, simulateMcPolicy, type SimConfig,
} from '@/lib/mrp/policy-sim'

const MS_PER_DAY = 86_400_000
const EMPTY_LEGS = { mfg: [], ocean: [], customs: [] }

// ---------------------------------------------------------------------------
// Part 1 — backtest.ts (pure, no IO/rng)
// ---------------------------------------------------------------------------

describe('demandOver', () => {
  const from = new Date('2026-01-01T00:00:00Z')

  it('excludes the from-date itself (exclusive) and includes the window end (inclusive)', () => {
    const events: HistEvent[] = [
      { event_date: '2026-01-01', qty: 100 }, // == from: excluded
      { event_date: '2026-01-02', qty: 5 },   // from+1d: included
      { event_date: '2026-01-11', qty: 7 },   // from+10d: included (window end)
    ]
    expect(demandOver(events, from, 10)).toBe(12)
  })

  it('excludes events past the window end', () => {
    const events: HistEvent[] = [
      { event_date: '2026-01-11', qty: 7 },  // from+10d: included
      { event_date: '2026-01-12', qty: 99 }, // from+11d: excluded
    ]
    expect(demandOver(events, from, 10)).toBe(7)
  })

  it('empty range (days=0) → 0 even with an event exactly on `from`', () => {
    expect(demandOver([{ event_date: '2026-01-01', qty: 50 }], from, 0)).toBe(0)
  })

  it('events entirely before `from` are excluded', () => {
    expect(demandOver([{ event_date: '2025-12-31', qty: 50 }], from, 10)).toBe(0)
  })

  it('empty events → 0', () => {
    expect(demandOver([], from, 79)).toBe(0)
  })
})

describe('calibrate', () => {
  it('a perfectly-calibrated synthetic set: 100 trials at p=0.3, 30 stocked out, lands in the 30-40 bucket', () => {
    const trials: Trial[] = Array.from({ length: 100 }, (_, i) => ({
      week: `w${i}`, position: 0, predicted: 0.3, stockedOut: i < 30,
    }))
    const buckets = calibrate(trials)
    expect(buckets).toHaveLength(1)
    expect(buckets[0].loPct).toBe(30)
    expect(buckets[0].hiPct).toBe(40)
    expect(buckets[0].n).toBe(100)
    expect(buckets[0].meanPredicted).toBeCloseTo(0.3, 10) // float summation of 100 * 0.3
    expect(buckets[0].observedRate).toBe(0.3)
  })

  it('buckets by decile and drops empty buckets', () => {
    const trials: Trial[] = [
      { week: 'a', position: 0, predicted: 0.05, stockedOut: false },
      { week: 'b', position: 0, predicted: 0.05, stockedOut: true },
      { week: 'c', position: 0, predicted: 0.95, stockedOut: true },
    ]
    const buckets = calibrate(trials)
    expect(buckets).toHaveLength(2) // the 10-90 middle deciles are all empty and dropped
    expect(buckets[0]).toEqual({ loPct: 0, hiPct: 10, n: 2, meanPredicted: 0.05, observedRate: 0.5 })
    expect(buckets[1]).toEqual({ loPct: 90, hiPct: 100, n: 1, meanPredicted: 0.95, observedRate: 1 })
  })

  it('a predicted value of exactly 1.0 lands in the top (90-100) bucket, not an 11th bucket', () => {
    const buckets = calibrate([{ week: 'a', position: 0, predicted: 1.0, stockedOut: true }])
    expect(buckets).toEqual([{ loPct: 90, hiPct: 100, n: 1, meanPredicted: 1, observedRate: 1 }])
  })

  it('empty trials → no buckets', () => {
    expect(calibrate([])).toEqual([])
  })
})

describe('brierScore', () => {
  it('all-correct-confident predictions score 0', () => {
    const trials: Trial[] = [
      { week: 'a', position: 0, predicted: 1, stockedOut: true },
      { week: 'b', position: 0, predicted: 0, stockedOut: false },
    ]
    expect(brierScore(trials)).toBe(0)
  })

  it('always-0.5 predictions score 0.25 regardless of outcome (coin flip)', () => {
    const trials: Trial[] = [
      { week: 'a', position: 0, predicted: 0.5, stockedOut: true },
      { week: 'b', position: 0, predicted: 0.5, stockedOut: false },
    ]
    expect(brierScore(trials)).toBeCloseTo(0.25, 10)
  })

  it('a known hand-computed case', () => {
    // (0.8-1)^2=0.04, (0.3-0)^2=0.09, (0.6-1)^2=0.16 -> mean = 0.29/3
    const trials: Trial[] = [
      { week: 'a', position: 0, predicted: 0.8, stockedOut: true },
      { week: 'b', position: 0, predicted: 0.3, stockedOut: false },
      { week: 'c', position: 0, predicted: 0.6, stockedOut: true },
    ]
    expect(brierScore(trials)).toBeCloseTo(0.29 / 3, 10)
  })

  it('empty trials → 0 (defensive, never NaN)', () => {
    expect(brierScore([])).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Part 2 — policy-sim.ts (pure)
// ---------------------------------------------------------------------------

/** One event per week, `qty` each, from `fromDaysBefore` (a multiple of 7) before
 * `anchor` through `through` inclusive — every event lands exactly on a weekIndex
 * boundary of a sim that starts at `anchor`. */
function constantWeeklyEvents(anchor: Date, qty: number, fromDaysBefore: number, through: Date): HistEvent[] {
  const out: HistEvent[] = []
  for (let t = anchor.getTime() - fromDaysBefore * MS_PER_DAY; t <= through.getTime(); t += 7 * MS_PER_DAY) {
    out.push({ event_date: new Date(t).toISOString().slice(0, 10), qty })
  }
  return out
}

const START = new Date('2025-01-06T00:00:00Z')
const weeksLater = (n: number) => new Date(START.getTime() + n * 7 * MS_PER_DAY)

function baseConfig(over: Partial<SimConfig> = {}): SimConfig {
  return {
    events: [], startDate: START, endDate: weeksLater(7), leadDays: 79, openingStock: 0,
    ltFactor: 0.25, varFactorFor: () => 1.0, moq: 0, containerQty: 0,
    legs: EMPTY_LEGS, rng: mulberry32(1),
    ...over,
  }
}

describe('simulateZonePolicy / simulateMcPolicy — shared weekly loop', () => {
  it('zero demand history → no orders, no stockouts (both policies)', () => {
    const zone = simulateZonePolicy(baseConfig())
    expect(zone.orders).toBe(0)
    expect(zone.unitsOrdered).toBe(0)
    expect(zone.stockoutWeeks).toBe(0)
    expect(zone.demandTotal).toBe(0)
    expect(zone.demandMet).toBe(0)

    const mc = simulateMcPolicy(baseConfig(), 0.1)
    expect(mc.orders).toBe(0)
    expect(mc.stockoutWeeks).toBe(0)
  })

  it('constant demand, generous opening stock → zone policy raises orders and fill rate is 1.0', () => {
    // adu ~ 1040/365 ~ 2.85/d (52 populated trailing weeks at qty 20); dlt 70,
    // ltFactor 0.25, varFactor pinned at 0.5 -> yellowTop ~275, greenTop ~325
    // (hand-derived, not asserted exactly). openingStock 350 crosses into
    // yellow within a few weeks but never gets remotely close to the 20/wk
    // demand rate over the 15-week window (worst case, zero reorders ever
    // arriving: 350 - 20*15 = 50, still positive every week).
    const events = constantWeeklyEvents(START, 20, 392, weeksLater(14))
    const c = baseConfig({
      events, endDate: weeksLater(14), leadDays: 70, openingStock: 350, varFactorFor: () => 0.5,
    })
    const res = simulateZonePolicy(c)
    expect(res.orders).toBeGreaterThan(0)
    expect(res.demandMet).toBe(res.demandTotal)
    expect(res.stockoutWeeks).toBe(0)
    expect(res.demandTotal).toBeGreaterThan(0)
  })

  it('orders arrive after exactly ceil(leadDays/7) weeks — on-hand jumps then, not before', () => {
    // No demand at all: onHand is 0 until the single triggered order (sized to
    // fill containerQty, since adu=0 -> zones are all 0 except green=containerQty)
    // lands, then flat at 100 for the rest of the window.
    const c = baseConfig({ containerQty: 100, leadDays: 20, endDate: weeksLater(6) })
    const res = simulateZonePolicy(c)
    expect(res.orders).toBe(1)
    expect(res.unitsOrdered).toBe(100)
    expect(res.peakOnHand).toBe(100)
    // 7 weekly samples (index 0..6): 0 for the first ceil(20/7)=3 weeks (0,1,2),
    // 100 for the remaining 4 (3,4,5,6) — pins the exact arrival week.
    expect(res.avgOnHand).toBeCloseTo((100 * 4) / 7, 10)
  })

  it('MC threshold 0 (always order) vs 1 (never order) bracket the zone policy order count', () => {
    const events = constantWeeklyEvents(START, 20, 392, weeksLater(14))
    const c = baseConfig({
      events, endDate: weeksLater(14), leadDays: 70, openingStock: 350, varFactorFor: () => 0.5,
      rng: mulberry32(5),
    })
    const zone = simulateZonePolicy(c)
    const mcAlways = simulateMcPolicy({ ...c, rng: mulberry32(5) }, 0)
    const mcNever = simulateMcPolicy({ ...c, rng: mulberry32(5) }, 1)

    expect(zone.orders).toBeGreaterThan(0)
    expect(mcNever.orders).toBe(0) // pStockout is a probability in [0,1]; p > 1 is never true
    expect(mcAlways.orders).toBeGreaterThanOrEqual(zone.orders)
    expect(mcNever.orders).toBeLessThanOrEqual(zone.orders)
  })

  it('determinism: same seed → identical PolicyResult', () => {
    const events = constantWeeklyEvents(START, 20, 392, weeksLater(10))
    const build = (): SimConfig => baseConfig({
      events, endDate: weeksLater(10), leadDays: 70, openingStock: 200, varFactorFor: () => 0.6,
      rng: mulberry32(77),
    })
    const a = simulateMcPolicy(build(), 0.1)
    const b = simulateMcPolicy(build(), 0.1)
    expect(a).toEqual(b)
  })
})
