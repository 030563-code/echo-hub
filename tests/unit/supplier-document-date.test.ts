import { describe, it, expect } from 'vitest'
import { supplierDocumentDate } from '@/lib/supplier-document-date'

/**
 * The date on a supplier document belongs to the order: the day it was SENT, or
 * before that the day it was raised. Never the day somebody downloaded it. The
 * factory's first order read a different date every time it was opened, and an
 * unsent preview kept doing the same until the fallback stopped being today.
 */
describe('supplierDocumentDate', () => {
  const raised = '2026-03-09T16:40:00Z'

  it('prints the send date once the order has been sent', () => {
    expect(supplierDocumentDate('2026-03-10T09:15:27.481+00:00', raised)).toBe('2026-03-10')
  })

  it('keeps the calendar day of the send, whatever the hour', () => {
    expect(supplierDocumentDate('2026-03-10T23:59:59Z', raised)).toBe('2026-03-10')
    expect(supplierDocumentDate('2026-03-10T00:00:00Z', raised)).toBe('2026-03-10')
  })

  it('prints the day the order was raised while nobody has sent it', () => {
    expect(supplierDocumentDate(null, raised)).toBe('2026-03-09')
    expect(supplierDocumentDate(undefined, raised)).toBe('2026-03-09')
    expect(supplierDocumentDate('', raised)).toBe('2026-03-09')
  })

  it('never prints Invalid Date, and never falls back to the clock', () => {
    expect(supplierDocumentDate('not a date', raised)).toBe('2026-03-09')
    expect(supplierDocumentDate(null, 'not a date either')).toBe('')
    expect(supplierDocumentDate(null, null)).toBe('')
  })
})
