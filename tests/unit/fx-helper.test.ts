import { describe, it, expect } from 'vitest'
import { pickFxRate } from '@/lib/fx-helper'

// Rows are passed newest-first (the query orders week_start_date DESC).
const rows = [
  { week_start_date: '2026-06-15', avg_rate: 1.1544 },
  { week_start_date: '2026-06-08', avg_rate: 1.16 },
  { week_start_date: '2026-06-01', avg_rate: 1.18 },
]
const asOf = new Date('2026-07-03T00:00:00Z') // Q3 2026 → prior quarter = Q2 (Apr–Jun)

describe('pickFxRate', () => {
  it('spot = the latest (first) week rate', () => {
    const r = pickFxRate(rows, 'spot', asOf)
    expect(r?.rate).toBe(1.1544)
    expect(r?.method).toBe('spot')
    expect(r?.week_start).toBe('2026-06-15')
    expect(r?.latest_week).toBe('2026-06-15')
    expect(r?.weeks_used).toBe(1)
  })

  it('rolling_13w = average of the window, week_start = the oldest week', () => {
    const r = pickFxRate(rows, 'rolling_13w', asOf)
    expect(r?.rate).toBe(1.1648) // round4((1.1544 + 1.16 + 1.18) / 3)
    expect(r?.week_start).toBe('2026-06-01')
    expect(r?.method).toBe('rolling_13w')
  })

  it('quarterly = average of the PREVIOUS calendar quarter, stable within a quarter', () => {
    // asOf is in Q3 2026, so the window is Q2 (Apr–Jun); all 3 rows fall in it.
    const r = pickFxRate(rows, 'quarterly', asOf)
    expect(r?.rate).toBe(1.1648)
    expect(r?.method).toBe('quarterly')
    expect(r?.basis).toBe('Q2 2026 average (3 wks)')
    // Same quarter, later date → identical rate (stability is the whole point).
    const laterSameQuarter = pickFxRate(rows, 'quarterly', new Date('2026-09-30T00:00:00Z'))
    expect(laterSameQuarter?.rate).toBe(r?.rate)
  })

  it('quarterly falls back to a rolling window when the prior quarter has no data', () => {
    // asOf in Q1 2026 → prior quarter Q4-2025 has no rows here → rolling fallback.
    const r = pickFxRate(rows, 'quarterly', new Date('2026-02-01T00:00:00Z'))
    expect(r?.rate).toBe(1.1648)
    expect(r?.basis).toContain('rolling')
  })

  it('coerces string rates and drops non-finite / empty', () => {
    expect(pickFxRate([{ week_start_date: '2026-06-15', avg_rate: '1.2' }], 'spot', asOf)?.rate).toBe(1.2)
    expect(pickFxRate([], 'spot', asOf)).toBeNull()
    expect(pickFxRate([{ week_start_date: 'x', avg_rate: 'NaN' }], 'spot', asOf)).toBeNull()
  })
})
