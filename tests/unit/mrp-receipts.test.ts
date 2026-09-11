import { describe, it, expect } from 'vitest'
import { transitDays } from '@/lib/mrp/receipts'

describe('transitDays', () => {
  it('returns fractional days for a normal span', () => {
    expect(transitDays('2026-07-01T00:00:00Z', '2026-07-22T12:00:00Z')).toBe(21.5)
  })
  it('accepts a bare date-only shippedAt (live column is `date`; PostgREST returns date-only strings; ES parses them as UTC midnight)', () => {
    expect(transitDays('2026-01-17', '2026-02-07T12:00:00Z')).toBe(21.5)
  })
  it('returns null when shippedAt is null', () => {
    expect(transitDays(null, '2026-07-22T12:00:00Z')).toBeNull()
  })
  it('returns null for a negative span', () => {
    expect(transitDays('2026-07-22T12:00:00Z', '2026-07-01T00:00:00Z')).toBeNull()
  })
  it('returns null for a zero span', () => {
    expect(transitDays('2026-07-01T00:00:00Z', '2026-07-01T00:00:00Z')).toBeNull()
  })
  it('returns null when the span is 365 days or more', () => {
    expect(transitDays('2025-07-01T00:00:00Z', '2026-07-01T00:00:00Z')).toBeNull()
  })
  it('returns null for an unparseable shippedAt', () => {
    expect(transitDays('not-a-date', '2026-07-22T12:00:00Z')).toBeNull()
  })
})
