import { describe, expect, it } from 'vitest'
import {
  DEFAULT_PAYMENT_TERM_DAYS,
  describeTerms,
  dueDateFromTerms,
} from '@/lib/customer-invoice/payment-terms'

describe('dueDateFromTerms', () => {
  it('falls back to Net 30 when Xero holds no terms (the common case)', () => {
    // Sonco, a real live contact, has PaymentTerms absent entirely.
    expect(dueDateFromTerms('2026-09-02', null)).toBe('2026-10-02')
  })

  it('DAYSAFTERBILLDATE counts plain days from the invoice date', () => {
    expect(dueDateFromTerms('2026-09-02', { day: 45, type: 'DAYSAFTERBILLDATE' })).toBe('2026-10-17')
    expect(dueDateFromTerms('2026-09-02', { day: 0, type: 'DAYSAFTERBILLDATE' })).toBe('2026-09-02')
  })

  it('DAYSAFTERBILLMONTH counts from the END of the invoice month, not the date', () => {
    // The whole point of the type: 10 here is 2026-10-10, not 2026-09-12.
    expect(dueDateFromTerms('2026-09-02', { day: 10, type: 'DAYSAFTERBILLMONTH' })).toBe('2026-10-10')
  })

  it('OFCURRENTMONTH is a day of the invoice month', () => {
    expect(dueDateFromTerms('2026-09-02', { day: 15, type: 'OFCURRENTMONTH' })).toBe('2026-09-15')
  })

  it('OFFOLLOWINGMONTH is a day of the next month', () => {
    expect(dueDateFromTerms('2026-09-02', { day: 15, type: 'OFFOLLOWINGMONTH' })).toBe('2026-10-15')
    expect(dueDateFromTerms('2026-12-20', { day: 5, type: 'OFFOLLOWINGMONTH' })).toBe('2027-01-05')
  })

  it('clamps a day that the target month does not have rather than rolling over', () => {
    // The 31st of February is 2026-02-28, not 2026-03-03.
    expect(dueDateFromTerms('2026-01-31', { day: 31, type: 'OFFOLLOWINGMONTH' })).toBe('2026-02-28')
    expect(dueDateFromTerms('2026-04-10', { day: 31, type: 'OFCURRENTMONTH' })).toBe('2026-04-30')
  })

  it('treats an unrecognised term type as no term rather than inventing a date', () => {
    // The number means nothing without a type we understand.
    expect(dueDateFromTerms('2026-09-02', { day: 7, type: 'SOMETHING_NEW' })).toBe('2026-10-02')
  })

  it('is case-insensitive on the type', () => {
    expect(dueDateFromTerms('2026-09-02', { day: 45, type: 'daysafterbilldate' })).toBe('2026-10-17')
  })

  it('is UTC-only, so it cannot shift a day in a negative-offset timezone', () => {
    // Parsing 'YYYY-MM-DD' via the Date constructor lands on the previous day
    // west of Greenwich; every case above would be off by one if it did.
    expect(dueDateFromTerms('2026-01-01', { day: 0, type: 'DAYSAFTERBILLDATE' })).toBe('2026-01-01')
    expect(dueDateFromTerms('2026-03-01', { day: 0, type: 'DAYSAFTERBILLDATE' })).toBe('2026-03-01')
  })

  it('crosses a year boundary correctly', () => {
    expect(dueDateFromTerms('2026-12-15', { day: 30, type: 'DAYSAFTERBILLDATE' })).toBe('2027-01-14')
  })

  it('rejects an unparseable invoice date rather than guessing', () => {
    expect(dueDateFromTerms('', null)).toBeNull()
    expect(dueDateFromTerms('02/09/2026', null)).toBeNull()
    expect(dueDateFromTerms('2026-13-45', null)).toBeNull()
  })

  it('ignores a negative or non-numeric day and uses the house default', () => {
    expect(dueDateFromTerms('2026-09-02', { day: -5, type: 'DAYSAFTERBILLDATE' })).toBe('2026-10-02')
    expect(dueDateFromTerms('2026-09-02', { day: Number.NaN, type: 'DAYSAFTERBILLDATE' })).toBe('2026-10-02')
  })

  it('uses the documented house default of 30 days', () => {
    expect(DEFAULT_PAYMENT_TERM_DAYS).toBe(30)
  })
})

describe('describeTerms', () => {
  it('names the absent case explicitly rather than implying a term exists', () => {
    expect(describeTerms(null)).toBe('Net 30 (no term set in Xero)')
  })

  it('describes each type in words a person can check', () => {
    expect(describeTerms({ day: 45, type: 'DAYSAFTERBILLDATE' })).toBe('Net 45')
    expect(describeTerms({ day: 10, type: 'DAYSAFTERBILLMONTH' })).toBe('10 day(s) after the end of the invoice month')
    expect(describeTerms({ day: 15, type: 'OFCURRENTMONTH' })).toBe('The 15th of the invoice month')
    expect(describeTerms({ day: 15, type: 'OFFOLLOWINGMONTH' })).toBe('The 15th of the following month')
  })
})
