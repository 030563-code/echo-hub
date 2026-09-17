import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  deepStats,
  percentile95,
  covOfTotals,
  redZoneWithLumpinessFloor,
  EMPTY_DEEP_STATS,
  LUMPINESS_MIN_ORDERS,
  LUMPINESS_MIN_MONTHS,
  type DeepDemandRow,
} from '@/lib/mrp/deep-history'
import {
  demandKey,
  splitDemandKey,
  organisationForDepot,
  ORGANISATIONS_WITH_STOCK,
  DEFAULT_ORGANISATION,
} from '@/lib/mrp/organisations'

function row(event_date: string, qty: number): DeepDemandRow {
  return { event_date, organisation: 'EB-USA', sku: 'EBH9NA', qty }
}

/** 14 monthly orders across 14 months, so the lumpiness gate is satisfied. */
function fourteenMonths(qtys: number[]): DeepDemandRow[] {
  return qtys.map((q, i) => {
    const month = String((i % 12) + 1).padStart(2, '0')
    const year = 2024 + Math.floor(i / 12)
    return row(`${year}-${month}-15`, q)
  })
}

describe('percentile95', () => {
  it('is nearest-rank, so it never invents a quantity nobody ordered', () => {
    // 20 values 1..20: ceil(0.95 * 20) = 19 -> the 19th smallest, which is 19.
    const values = Array.from({ length: 20 }, (_, i) => i + 1)
    expect(percentile95(values)).toBe(19)
    expect(values).toContain(percentile95(values))
  })

  it('is the maximum when the sample is small, which is the honest answer', () => {
    expect(percentile95([5, 10, 3])).toBe(10)
  })

  it('ignores zero, negative and non-finite quantities', () => {
    expect(percentile95([0, -5, Number.NaN, 7])).toBe(7)
  })

  it('returns 0 for an empty set rather than NaN', () => {
    expect(percentile95([])).toBe(0)
  })
})

describe('covOfTotals', () => {
  it('is null under two periods, because nothing can vary', () => {
    expect(covOfTotals([])).toBeNull()
    expect(covOfTotals([10])).toBeNull()
  })

  it('is zero for a perfectly flat series', () => {
    expect(covOfTotals([10, 10, 10, 10])).toBe(0)
  })

  it('is null when the mean is zero, rather than dividing by it', () => {
    expect(covOfTotals([0, 0, 0])).toBeNull()
  })

  it('rises with lumpiness', () => {
    const steady = covOfTotals([10, 11, 9, 10])!
    const lumpy = covOfTotals([0, 0, 0, 40])!
    expect(lumpy).toBeGreaterThan(steady)
  })
})

describe('deepStats', () => {
  it('returns the empty shape for no rows rather than NaN', () => {
    expect(deepStats([], '2026-09-17')).toEqual(EMPTY_DEEP_STATS)
  })

  it('counts distinct months and order lines', () => {
    const rows = [row('2025-01-10', 5), row('2025-01-20', 7), row('2025-03-01', 9)]
    const s = deepStats(rows, '2025-03-31')
    expect(s.months).toBe(2)
    expect(s.orders).toBe(3)
    expect(s.from).toBe('2025-01-10')
    expect(s.maxOrder).toBe(9)
  })

  it('counts the quiet months as zeros, so a bursty product reads as variable', () => {
    // One order in January, nothing until December: eleven zero months in between.
    const bursty = deepStats([row('2025-01-15', 120)], '2025-12-31')
    const steady = deepStats(
      Array.from({ length: 12 }, (_, i) => row(`2025-${String(i + 1).padStart(2, '0')}-15`, 10)),
      '2025-12-31'
    )
    expect(bursty.cov!).toBeGreaterThan(steady.cov!)
    expect(steady.cov).toBe(0)
  })

  it('spreads ADU over the whole span, not just the months that traded', () => {
    // 100 units on day one, measured a year later: roughly 100/366 a day, not 100/1.
    const s = deepStats([row('2025-01-01', 100)], '2025-12-31')
    expect(s.adu).toBeGreaterThan(0.2)
    expect(s.adu).toBeLessThan(0.3)
  })

  it('ignores rows whose date is not an ISO date rather than throwing', () => {
    const s = deepStats([{ ...row('not-a-date', 5) }, row('2025-05-05', 5)], '2025-06-01')
    expect(s.from).toBe('2025-05-05')
  })
})

describe('redZoneWithLumpinessFloor', () => {
  it('is gated off until there are enough orders AND enough months', () => {
    const thin = { p95Order: 500, orders: LUMPINESS_MIN_ORDERS - 1, months: 24 }
    expect(redZoneWithLumpinessFloor(10, thin)).toEqual({ red: 10, raised: false, gated: true })

    const short = { p95Order: 500, orders: 50, months: LUMPINESS_MIN_MONTHS - 1 }
    expect(redZoneWithLumpinessFloor(10, short)).toEqual({ red: 10, raised: false, gated: true })
  })

  it('raises the red zone to cover a 95th percentile order once the gate opens', () => {
    const deep = { p95Order: 500, orders: 40, months: 24 }
    expect(redZoneWithLumpinessFloor(10, deep)).toEqual({ red: 500, raised: true, gated: false })
  })

  it('leaves a red zone that already covers the percentile alone', () => {
    const deep = { p95Order: 100, orders: 40, months: 24 }
    expect(redZoneWithLumpinessFloor(250, deep)).toEqual({ red: 250, raised: false, gated: false })
  })

  it('rounds the floor up, because a buffer is whole units', () => {
    const deep = { p95Order: 10.2, orders: 40, months: 24 }
    expect(redZoneWithLumpinessFloor(5, deep).red).toBe(11)
  })

  it('never returns NaN on a non-finite percentile', () => {
    const deep = { p95Order: Number.NaN, orders: 40, months: 24 }
    expect(redZoneWithLumpinessFloor(7, deep).red).toBe(7)
  })

  it('a realistic lumpy series raises the buffer and a steady one does not', () => {
    const lumpy = deepStats(fourteenMonths([5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 400]), '2025-06-30')
    const steady = deepStats(fourteenMonths([10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10]), '2025-06-30')
    expect(redZoneWithLumpinessFloor(20, lumpy).raised).toBe(true)
    expect(redZoneWithLumpinessFloor(20, steady).raised).toBe(false)
  })
})

describe('organisation keying', () => {
  it('round-trips a key', () => {
    expect(splitDemandKey(demandKey('EB-UK', 'EBH9'))).toEqual({ organisation: 'EB-UK', sku: 'EBH9' })
  })

  it('keeps two organisations apart for the same SKU', () => {
    expect(demandKey('EB-UK', 'EBH9NA')).not.toBe(demandKey('EB-USA', 'EBH9NA'))
  })

  it('falls back to the default organisation on a key with no separator', () => {
    expect(splitDemandKey('EBH9NA')).toEqual({ organisation: DEFAULT_ORGANISATION, sku: 'EBH9NA' })
  })

  it('maps the depots that have a stock feed to their owner', () => {
    expect(organisationForDepot('US-BAL')).toBe('EB-USA')
    expect(organisationForDepot('US-SBD')).toBe('EB-USA')
    expect(organisationForDepot('CA-HAM')).toBe('EB-CANADA')
    expect(organisationForDepot('GB-BSE')).toBe('EB-UK')
    expect(organisationForDepot('nonsense')).toBeNull()
    expect(organisationForDepot(null)).toBeNull()
  })

  it('only claims a stock feed for the organisations that actually have one', () => {
    // Since the stock consolidation, warehouse_stock_levels is the single source of truth and
    // carries all seven depots: North America and the factory from physical counts, UK, France
    // and Group synced from their Xero item ledgers.
    expect([...ORGANISATIONS_WITH_STOCK].sort()).toEqual([
      'EB-CANADA', 'EB-FRANCE', 'EB-GROUP', 'EB-SRO', 'EB-UK', 'EB-USA',
    ])
    // Australia is genuinely empty while it is rebuilt, so it must NOT claim a feed.
    expect(ORGANISATIONS_WITH_STOCK).not.toContain('EB-AUSTRALIA')
    // 🔴 Group DOES hold stock, transiently: it appears and disappears as it passes from the
    // factory to a region. A near-zero level there is throughput, not a stockout.
    expect(organisationForDepot('EB-GROUP')).toBe('EB-GROUP')
  })
})

describe('guard: the engine keeps organisations apart', () => {
  const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')

  it('buckets demand on the composite key, never on sku alone', () => {
    const src = read('src/lib/mrp/engine.ts')
    expect(src).toContain('const eventsByKey = new Map<string, DemandEventRow[]>()')
    expect(src).toContain('demandKey(e.organisation, resolve(e.sku))')
    expect(src).not.toContain('eventsBySku')
  })

  it('stamps the organisation on every persisted status row and write-back', () => {
    const src = read('src/lib/mrp/engine.ts')
    expect(src).toContain('organisation: p.organisation,')
  })

  it('matches a profile write-back on organisation AND sku', () => {
    const src = read('src/lib/mrp/engine-data.ts')
    expect(src).toContain('.eq("organisation", organisation)')
    expect(src).toContain('.eq("sku", sku)')
    expect(src).toContain('onConflict: "run_date,organisation,sku"')
  })

  it('reads the corrected feed, not the contaminated demand table', () => {
    const src = read('src/lib/mrp/engine-data.ts')
    expect(src).toContain('mrp_demand_engine_feed')
    // The region filter is what used to hide every non-US organisation.
    expect(src).not.toContain('.in("region", ["US", "CA"])')
    // mrp_demand_events survives for ONE purpose: the set of HubSpot deal ids already represented
    // in the ledger, which is a dedupe key and carries no quantity. It must never supply demand
    // quantities again, so the only column read from it is source_ref.
    const uses = src.split('.from("mrp_demand_events")').slice(1)
    expect(uses).toHaveLength(1)
    expect(uses[0].slice(0, 120)).toContain('.select("source_ref")')
  })

  it('computes no seasonal factor anywhere, which was tested and rejected', () => {
    const deep = read('src/lib/mrp/deep-history.ts')
    const engine = read('src/lib/mrp/engine.ts')
    const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    expect(strip(deep)).not.toMatch(/season/i)
    expect(strip(engine)).not.toMatch(/season/i)
  })
})
