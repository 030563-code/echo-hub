import { describe, it, expect } from 'vitest'
import {
  mulberry32,
  seedFrom,
  fitMarkov,
  triangular,
  jitterSize,
  simulateStockout,
  type McInput,
  type McLegSamples,
} from '@/lib/mrp/montecarlo'
import { runMrpEngine, type EngineData, type ProfileRow, type StatusDailyRow, type SpikeRegisterRow, type ProfileWriteBack } from '@/lib/mrp/engine'

const MS_PER_DAY = 86_400_000
const NOW = new Date('2026-08-08T00:00:00Z')
const EMPTY_LEGS: McLegSamples = { mfg: [], ocean: [], customs: [] }

// ---------------------------------------------------------------------------
// Seeded RNG — golden values (computed once, pinned)
// ---------------------------------------------------------------------------

describe('mulberry32', () => {
  it('produces pinned deterministic output for a known seed', () => {
    const rng = mulberry32(1)
    expect(rng()).toBeCloseTo(0.6270739405881613, 12)
    expect(rng()).toBeCloseTo(0.002735721180215478, 12)
    expect(rng()).toBeCloseTo(0.5274470399599522, 12)
    expect(rng()).toBeCloseTo(0.9810509674716741, 12)
    expect(rng()).toBeCloseTo(0.9683778982143849, 12)
  })
  it('a different seed produces a different pinned sequence', () => {
    const rng = mulberry32(42)
    expect(rng()).toBeCloseTo(0.6011037519201636, 12)
    expect(rng()).toBeCloseTo(0.44829055899754167, 12)
    expect(rng()).toBeCloseTo(0.8524657934904099, 12)
  })
  it('every draw lands in [0, 1)', () => {
    const rng = mulberry32(7)
    for (let i = 0; i < 1000; i++) {
      const v = rng()
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThan(1)
    }
  })
})

describe('seedFrom', () => {
  it('FNV-1a 32-bit — pinned golden hashes', () => {
    expect(seedFrom('test')).toBe(2949673445)
    expect(seedFrom('2026-08-08:EBH9NA')).toBe(2317738524)
    expect(seedFrom('')).toBe(2166136261)
  })
  it('is deterministic and sku-sensitive (different sku, different seed)', () => {
    expect(seedFrom('2026-08-08:EBH9NA')).toBe(seedFrom('2026-08-08:EBH9NA'))
    expect(seedFrom('2026-08-08:EBH9NA')).not.toBe(seedFrom('2026-08-08:EBH10NA'))
  })
})

// ---------------------------------------------------------------------------
// Triangular sampler
// ---------------------------------------------------------------------------

describe('triangular', () => {
  it('respects [min, max] bounds over 1000 draws', () => {
    const rng = mulberry32(1)
    for (let i = 0; i < 1000; i++) {
      const v = triangular(45, 45, 75, rng())
      expect(v).toBeGreaterThanOrEqual(45)
      expect(v).toBeLessThanOrEqual(75)
    }
  })
  it('the mode region draws more often than an equal-width region near the tail (loose density check)', () => {
    const rng = mulberry32(2)
    let near = 0
    let far = 0
    for (let i = 0; i < 5000; i++) {
      const v = triangular(0, 5, 10, rng())
      if (v >= 4 && v <= 6) near++
      if (v >= 8 && v <= 10) far++
    }
    expect(near).toBeGreaterThan(far)
  })
})

// ---------------------------------------------------------------------------
// Markov occurrence fit
// ---------------------------------------------------------------------------

describe('fitMarkov', () => {
  it('all-inactive weeks → smoothed p01 small but > 0 (never collapses to 0)', () => {
    const fit = fitMarkov(Array(52).fill(0))
    expect(fit.p01).toBeGreaterThan(0)
    expect(fit.p01).toBeLessThan(0.05)
    expect(fit.lastActive).toBe(false)
  })
  it('alternating weeks → p01 high, p11 low', () => {
    const totals = Array.from({ length: 52 }, (_, i) => (i % 2 === 0 ? 0 : 10))
    const fit = fitMarkov(totals)
    expect(fit.p01).toBeGreaterThan(0.9)
    expect(fit.p11).toBeLessThan(0.1)
  })
  it('all-active weeks → p11 near 1 but strictly < 1 (never collapses to 1)', () => {
    const fit = fitMarkov(Array(52).fill(10))
    expect(fit.p11).toBeGreaterThan(0.9)
    expect(fit.p11).toBeLessThan(1)
    expect(fit.lastActive).toBe(true)
  })
  it('empty series degrades to a neutral 0.5/0.5 fit rather than crashing', () => {
    const fit = fitMarkov([])
    expect(fit.p01).toBe(0.5)
    expect(fit.p11).toBe(0.5)
    expect(fit.lastActive).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Jitter
// ---------------------------------------------------------------------------

describe('jitterSize', () => {
  it('stays within ±25% + rounding of the empirical value, and never below 1', () => {
    const rng = mulberry32(3)
    const lo = Math.round(10 * 0.75)
    const hi = Math.round(10 * 1.25)
    for (let i = 0; i < 2000; i++) {
      const v = jitterSize(10, rng)
      expect(v).toBeGreaterThanOrEqual(lo)
      expect(v).toBeLessThanOrEqual(hi)
    }
  })
  it('a size of 1 always floors at 1, never 0', () => {
    const rng = mulberry32(4)
    for (let i = 0; i < 500; i++) {
      expect(jitterSize(1, rng)).toBeGreaterThanOrEqual(1)
    }
  })
})

// ---------------------------------------------------------------------------
// End-to-end small cases
// ---------------------------------------------------------------------------

/** Steady qty/wk demand: one event per trailing ISO week (all-active history). */
function steadyWeeklyEvents(now: Date, weeks: number, qty: number): { event_date: string; qty: number }[] {
  const out: { event_date: string; qty: number }[] = []
  for (let i = 0; i < weeks; i++) {
    const d = new Date(now.getTime() - i * 7 * MS_PER_DAY)
    out.push({ event_date: d.toISOString().slice(0, 10), qty })
  }
  return out
}

describe('simulateStockout — end-to-end small cases', () => {
  it('returns null when there is no local demand history at all', () => {
    const res = simulateStockout({
      events: [], now: NOW, onHand: 100, arrivals: [], spikes: [], legs: EMPTY_LEGS, rng: mulberry32(1),
    })
    expect(res).toBeNull()
  })

  it('huge onHand against steady demand → pStockout ≈ 0', () => {
    const res = simulateStockout({
      events: steadyWeeklyEvents(NOW, 52, 10),
      now: NOW, onHand: 1_000_000, arrivals: [], spikes: [], legs: EMPTY_LEGS,
      iterations: 2000, rng: mulberry32(1),
    })!
    expect(res.pStockout).toBeLessThan(0.01)
  })

  it('zero onHand, no arrivals, steady demand → pStockout ≈ 1', () => {
    const res = simulateStockout({
      events: steadyWeeklyEvents(NOW, 52, 10),
      now: NOW, onHand: 0, arrivals: [], spikes: [], legs: EMPTY_LEGS,
      iterations: 2000, rng: mulberry32(1),
    })!
    expect(res.pStockout).toBeGreaterThan(0.9)
  })

  it('an arrival landing inside L pushes pStockout down vs the same arrival landing outside L', () => {
    const events = steadyWeeklyEvents(NOW, 52, 10)
    const base = (etaDaysFromNow: number) =>
      simulateStockout({
        events, now: NOW, onHand: 0,
        arrivals: [{ qty: 1_000_000, etaDaysFromNow }],
        spikes: [], legs: EMPTY_LEGS, iterations: 2000, rng: mulberry32(9),
      })!
    const inside = base(1) // any realistic L (min ~67d) clears this
    const outside = base(100_000) // never inside any realistic L
    expect(inside.pStockout).toBeLessThan(outside.pStockout)
    expect(inside.pStockout).toBeLessThan(0.01)
  })
})

describe('simulateStockout — spikes', () => {
  it('a spike with weight 1 strictly increases pStockout vs weight 0 (same seed)', () => {
    const events = steadyWeeklyEvents(NOW, 4, 1) // thin history, low base demand
    const build = (weight: number): McInput => ({
      events, now: NOW, onHand: 20, arrivals: [],
      spikes: [{ qty: 500, weight }], legs: EMPTY_LEGS, iterations: 2000, rng: mulberry32(11),
    })
    const withoutSpike = simulateStockout(build(0))!
    const withSpike = simulateStockout(build(1))!
    expect(withSpike.pStockout).toBeGreaterThan(withoutSpike.pStockout)
  })
})

// ---------------------------------------------------------------------------
// CI + dataGrade
// ---------------------------------------------------------------------------

describe('simulateStockout — CI', () => {
  it('a fair-coin outcome (spike weight 0.5, deterministic threshold) yields ci in a plausible band', () => {
    // onHand=50 sits strictly between "no spike" demand (~0-1, from a thin,
    // out-of-window base history) and "spike fires" demand (~100) — short_i
    // is then essentially the spike's own Bernoulli(0.5) draw, a fair coin.
    const res = simulateStockout({
      events: [{ event_date: '2020-01-01', qty: 1 }], // outside the 52-week window
      now: NOW, onHand: 50, arrivals: [],
      spikes: [{ qty: 100, weight: 0.5 }], legs: EMPTY_LEGS,
      iterations: 10_000, rng: mulberry32(1),
    })!
    expect(res.pStockout).toBeGreaterThan(0.4)
    expect(res.pStockout).toBeLessThan(0.6)
    expect(res.ci).toBeGreaterThan(0.01)
    expect(res.ci).toBeLessThan(0.2)
  })
})

describe('simulateStockout — dataGrade thresholds', () => {
  const makeEvents = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ event_date: `2020-01-0${(i % 9) + 1}`, qty: 1 }))

  it('4 events → C, 5 → B, 19 → B, 20 → A', () => {
    const grade = (n: number) =>
      simulateStockout({
        events: makeEvents(n), now: NOW, onHand: 10, arrivals: [], spikes: [], legs: EMPTY_LEGS,
        iterations: 200, rng: mulberry32(1),
      })!.dataGrade
    expect(grade(4)).toBe('C')
    expect(grade(5)).toBe('B')
    expect(grade(19)).toBe('B')
    expect(grade(20)).toBe('A')
  })
})

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

describe('simulateStockout — determinism', () => {
  it('identical input + seed → identical McResult', () => {
    const events = steadyWeeklyEvents(NOW, 30, 7)
    const build = (): McInput => ({
      events, now: NOW, onHand: 40,
      arrivals: [{ qty: 20, etaDaysFromNow: 50 }],
      spikes: [{ qty: 15, weight: 0.4 }],
      legs: { mfg: [40, 42, 44, 46, 48, 41, 43, 45, 47, 49], ocean: [], customs: [] },
      iterations: 1000, rng: mulberry32(seedFrom('2026-08-08:EBH9NA')),
    })
    const a = simulateStockout(build())
    const b = simulateStockout(build())
    expect(a).toEqual(b)
  })
})

// ---------------------------------------------------------------------------
// Engine integration
// ---------------------------------------------------------------------------

interface Fixtures {
  profiles: ProfileRow[]
  demandEvents: { event_date: string; sku: string; qty: number; source: string }[]
  shipments: { sku: string; qty: number; status: string; po_id: string | null; eta: string | null }[]
  legActuals: { leg: string; days: number }[]
}

function makeEngineData(over: Partial<Fixtures> = {}): { data: EngineData; captured: StatusDailyRow[][] } {
  const f: Fixtures = { profiles: [], demandEvents: [], shipments: [], legActuals: [], ...over }
  const captured: StatusDailyRow[][] = []
  const spikesCaptured: SpikeRegisterRow[][] = []
  const writeBacksCaptured: ProfileWriteBack[][] = []
  const data: EngineData = {
    profiles: () => Promise.resolve(f.profiles),
    demandEvents: (since) => Promise.resolve(f.demandEvents.filter((e) => e.event_date > since)),
    stockLevels: () => Promise.resolve([]),
    shipments: () => Promise.resolve(f.shipments),
    openPoLines: () => Promise.resolve([]),
    stageWeights: () => Promise.resolve([]),
    openDeals: () => Promise.resolve([]),
    closedWonDeals: () => Promise.resolve([]),
    hubspotDemandDealIds: () => Promise.resolve(new Set()),
    bomProducts: () => Promise.resolve([]),
    bomComponents: () => Promise.resolve([]),
    bomSkuMap: () => Promise.resolve([]),
    materialStock: () => Promise.resolve([]),
    doorLeadTimeDays: () => Promise.resolve([]),
    receiptRows: () => Promise.resolve([]),
    legActuals: () => Promise.resolve(f.legActuals),
    persistStatus: (rows) => { captured.push(rows); return Promise.resolve() },
    persistSpikes: (rows) => { spikesCaptured.push(rows); return Promise.resolve() },
    writeBackProfiles: (rows) => { writeBacksCaptured.push(rows); return Promise.resolve() },
  }
  return { data, captured }
}

function engineProfile(over: Partial<ProfileRow> & { sku: string }): ProfileRow {
  return {
    sku_class: 'slow', family_sku: null, adu: null, adu_source: 'auto', cov: null,
    dlt_days: 75, mfg_lt: 45, ocean_lt: 21, customs_lt: 9, lt_factor: 0.25,
    var_factor: null, moq: 0, container_qty: null, seeded: true, alias_of: null,
    ...over,
  }
}

describe('runMrpEngine — Monte Carlo wiring', () => {
  it('yields a non-null p_stockout for a SKU with events, null for one without', async () => {
    const { data, captured } = makeEngineData({
      profiles: [engineProfile({ sku: 'EBH9NA' }), engineProfile({ sku: 'EBVFKNA' })],
      demandEvents: [
        { event_date: '2026-07-01', sku: 'EBH9NA', qty: 162, source: 'xero_invoice' },
      ],
    })
    const res = await runMrpEngine(data, { now: NOW })
    const withEvents = res.rows.find((r) => r.sku === 'EBH9NA')!
    const withoutEvents = res.rows.find((r) => r.sku === 'EBVFKNA')!

    expect(withEvents.p_stockout).not.toBeNull()
    expect(withEvents.p_stockout_ci).not.toBeNull()
    expect(withEvents.data_grade).not.toBeNull()

    expect(withoutEvents.p_stockout).toBeNull()
    expect(withoutEvents.p_stockout_ci).toBeNull()
    expect(withoutEvents.data_grade).toBeNull()

    // Persisted rows carry the same fields.
    const persisted = captured[0].find((r) => r.sku === 'EBH9NA')!
    expect(persisted.p_stockout).not.toBeNull()
  })

  it('dry-run rows carry the fields too (MC is pure — only persistence is gated)', async () => {
    const { data, captured } = makeEngineData({
      profiles: [engineProfile({ sku: 'EBH9NA' })],
      demandEvents: [{ event_date: '2026-07-01', sku: 'EBH9NA', qty: 50, source: 'xero_invoice' }],
    })
    const res = await runMrpEngine(data, { now: NOW, dryRun: true })
    expect(res.rows[0].p_stockout).not.toBeNull()
    expect(captured).toHaveLength(0) // still nothing persisted
  })
})
