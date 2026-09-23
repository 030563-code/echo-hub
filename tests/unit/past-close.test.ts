import { describe, it, expect } from 'vitest'
import {
  byCsoOrder,
  closeDay,
  daysPastClose,
  isPastClose,
  pastCloseFilters,
  pastCloseOrgFilters,
  startOfUtcDay,
} from '@/lib/past-close'

/**
 * The Quotes banner's rule, which must be the CSO's rule (cso-brain/scripts/crm-hygiene-check.mjs
 * check 2, and pastCloseRows in sales-desk-pack.mjs): open, and the UTC date of the close date
 * before today's UTC date. Dean, 23 Sep 2026: "same thing the CSO looks at".
 */

// 23 Sep 2026, 14:30 UTC.
const NOW = Date.parse('2026-09-23T14:30:00Z')

/** The CSO's own expression, copied from the scripts, so a drift in either shows up here. */
const csoSaysPast = (closedate: string | null, nowMs: number) =>
  !!closedate && String(closedate).slice(0, 10) < new Date(nowMs).toISOString().slice(0, 10)

describe('past close date', () => {
  it('starts today at UTC midnight', () => {
    expect(new Date(startOfUtcDay(NOW)).toISOString()).toBe('2026-09-23T00:00:00.000Z')
  })

  it('counts yesterday up to its last instant, and never today', () => {
    expect(isPastClose('2026-09-22T23:59:59.999Z', NOW)).toBe(true)
    expect(isPastClose('2026-09-22T00:00:00Z', NOW)).toBe(true)
    expect(isPastClose('2026-09-23T00:00:00Z', NOW)).toBe(false)
    expect(isPastClose('2026-09-23T23:00:00Z', NOW)).toBe(false)
    expect(isPastClose('2026-10-01T09:00:00Z', NOW)).toBe(false)
  })

  it('treats a missing or unreadable close date as not past, like the CSO', () => {
    for (const value of [null, undefined, '', '   ', 'soon', '12/08/2026']) {
      expect(isPastClose(value, NOW), String(value)).toBe(false)
      expect(closeDay(value), String(value)).toBeNull()
    }
  })

  it('agrees with the CSO scripts on every case that matters', () => {
    const cases = [
      '2026-09-22T23:59:59.999Z', '2026-09-23T00:00:00.000Z', '2025-12-31T10:00:00Z',
      '2026-09-23T13:00:00Z', '2027-01-01T00:00:00Z', '2026-09-22', '2026-09-23',
    ]
    for (const value of cases) expect(isPastClose(value, NOW), value).toBe(csoSaysPast(value, NOW))
  })

  it('agrees with the HubSpot search it sends', () => {
    // The search asks for closedate < today's UTC midnight; the rule applied to the rows must
    // accept exactly the same instants, or the count and the list could differ.
    const cutoff = Number(pastCloseFilters('1', NOW).find((f) => f.propertyName === 'closedate')!.value)
    for (const value of ['2026-09-22T23:59:59.999Z', '2026-09-23T00:00:00.000Z', '2026-09-23T00:00:00.001Z', '2026-01-01T00:00:00Z']) {
      expect(isPastClose(value, NOW), value).toBe(Date.parse(value) < cutoff)
    }
  })

  it('counts whole calendar days, so a date yesterday evening is one day ago, not zero', () => {
    expect(daysPastClose('2026-09-22T22:00:00Z', NOW)).toBe(1)
    expect(daysPastClose('2026-08-12T09:00:00Z', NOW)).toBe(42)
    expect(daysPastClose('2026-09-23T01:00:00Z', NOW)).toBeNull()
    expect(daysPastClose(null, NOW)).toBeNull()
  })

  it('lists in the CSO order: the largest amount first, then the oldest close date', () => {
    const rows = [
      { id: 'small-old', amount: 100, closeDay: '2024-01-01' },
      { id: 'none', amount: null, closeDay: '2023-05-01' },
      { id: 'big-new', amount: 9000, closeDay: '2026-09-01' },
      { id: 'big-old', amount: 9000, closeDay: '2025-02-01' },
    ]
    expect([...rows].sort(byCsoOrder).map((r) => r.id)).toEqual(['big-old', 'big-new', 'small-old', 'none'])
  })

  it("searches an admin's whole organisation by its pipeline, whoever owns the deal", () => {
    expect(pastCloseOrgFilters('dfc85d9e-7eb9-4ade-a9cf-4e726cbcc9cc', NOW)).toEqual([
      { propertyName: 'pipeline', operator: 'EQ', value: 'dfc85d9e-7eb9-4ade-a9cf-4e726cbcc9cc' },
      { propertyName: 'hs_is_closed', operator: 'EQ', value: 'false' },
      { propertyName: 'closedate', operator: 'LT', value: String(Date.parse('2026-09-23T00:00:00Z')) },
    ])
    expect(pastCloseOrgFilters('x', NOW).some((f) => f.propertyName === 'hubspot_owner_id')).toBe(false)
  })

  it('searches one owner, open deals only by hs_is_closed, and nothing else', () => {
    expect(pastCloseFilters('82370091', NOW)).toEqual([
      { propertyName: 'hubspot_owner_id', operator: 'EQ', value: '82370091' },
      { propertyName: 'hs_is_closed', operator: 'EQ', value: 'false' },
      { propertyName: 'closedate', operator: 'LT', value: String(Date.parse('2026-09-23T00:00:00Z')) },
    ])
  })
})
