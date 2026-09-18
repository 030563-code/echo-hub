import { describe, it, expect } from 'vitest'
import { supplierDocumentDate } from '@/lib/supplier-document-date'

/**
 * The date on a supplier document is the day the order was SENT, not the day
 * somebody downloaded it. Dean, 18 Sep 2026, after the factory's first order
 * read a different date every time it was opened.
 */
describe('supplierDocumentDate', () => {
  const now = new Date('2026-09-18T09:30:00Z')

  it('prints the send date once the order has been sent', () => {
    expect(supplierDocumentDate('2026-09-17T15:10:54.213+00:00', now)).toBe('2026-09-17')
  })

  it('keeps the calendar day of the send, whatever the hour', () => {
    // The live order went at 15:10 UTC; a download the next morning must not move it.
    expect(supplierDocumentDate('2026-09-17T23:59:59Z', now)).toBe('2026-09-17')
    expect(supplierDocumentDate('2026-09-17T00:00:00Z', now)).toBe('2026-09-17')
  })

  it('falls back to today for an order nobody has sent yet, which is what a preview is', () => {
    expect(supplierDocumentDate(null, now)).toBe('2026-09-18')
    expect(supplierDocumentDate(undefined, now)).toBe('2026-09-18')
    expect(supplierDocumentDate('', now)).toBe('2026-09-18')
  })

  it('never prints Invalid Date', () => {
    expect(supplierDocumentDate('not a date', now)).toBe('2026-09-18')
  })
})
