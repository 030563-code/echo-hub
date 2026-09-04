import { describe, expect, it, afterAll, beforeAll } from 'vitest'
import { formatDate, formatRelative } from '@/lib/utils'

/**
 * Dates read in US form, and the timezone trap that comes with it.
 *
 * `new Date('2026-09-05')` is UTC midnight. Formatted in the viewer's local
 * zone anywhere west of Greenwich that is still September 4, so every
 * date-only value (expires_on, valid_from, week_start_date) would print a day
 * early for exactly the US users the format is for. The whole suite runs under
 * a US timezone so a regression cannot pass here and fail in Baltimore.
 */
const originalTZ = process.env.TZ

beforeAll(() => {
  process.env.TZ = 'America/Los_Angeles'
})

afterAll(() => {
  process.env.TZ = originalTZ
})

describe('formatDate', () => {
  it('renders a date-only string in US long form', () => {
    expect(formatDate('2026-09-05')).toBe('September 5, 2026')
  })

  it('does not shift a date-only string back a day in a US timezone', () => {
    // The regression this file exists for. Local formatting of UTC midnight
    // would give "September 4, 2026" here.
    expect(formatDate('2026-01-01')).toBe('January 1, 2026')
    expect(formatDate('2026-12-31')).toBe('December 31, 2026')
  })

  it('renders a timestamp in the viewer timezone', () => {
    // Midday UTC, so every zone from -12 to +11 agrees on the calendar day and
    // the assertion does not depend on which US zone the test runs in.
    expect(formatDate('2026-09-05T12:00:00Z')).toBe('September 5, 2026')
  })

  it('uses no leading zero on the day', () => {
    expect(formatDate('2026-09-05')).not.toContain('05')
  })

  it('returns the placeholder for a missing date', () => {
    expect(formatDate(null)).toBe('—')
    expect(formatDate(undefined)).toBe('—')
    expect(formatDate('')).toBe('—')
  })

  it('returns the raw value rather than "Invalid Date"', () => {
    expect(formatDate('not a date')).toBe('not a date')
  })
})

describe('formatRelative', () => {
  it('falls back to the US long form past 30 days', () => {
    expect(formatRelative('2020-01-15T12:00:00Z')).toBe('January 15, 2020')
  })

  it('still says Today for now', () => {
    expect(formatRelative(new Date().toISOString())).toBe('Today')
  })
})
