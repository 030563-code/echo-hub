import { describe, it, expect } from 'vitest'
import { buildStockIncrements, transitDays } from '@/lib/mrp/receipts'

describe('buildStockIncrements', () => {
  it('aggregates received qtys per sku for the receiving depot', () => {
    const poLines = new Map([
      ['l1', { id: 'l1', sku: 'EBH9NA', quantity: 100 }],
      ['l2', { id: 'l2', sku: 'EBH10NA', quantity: 40 }],
    ])
    const received = [
      { lineId: 'l1', qty: 60 }, { lineId: 'l1', qty: 40 }, { lineId: 'l2', qty: 40 },
    ]
    expect(buildStockIncrements(received, poLines, 'US-BAL')).toEqual([
      { warehouse_code: 'US-BAL', sku: 'EBH9NA', delta: 100 },
      { warehouse_code: 'US-BAL', sku: 'EBH10NA', delta: 40 },
    ])
  })
  it('skips unknown lines and zero qtys', () => {
    const poLines = new Map([['l1', { id: 'l1', sku: 'EBH9NA', quantity: 10 }]])
    expect(
      buildStockIncrements([{ lineId: 'nope', qty: 5 }, { lineId: 'l1', qty: 0 }], poLines, 'US-BAL'),
    ).toEqual([])
  })
})

describe('transitDays', () => {
  it('returns fractional days for a normal span', () => {
    expect(transitDays('2026-07-01T00:00:00Z', '2026-07-22T12:00:00Z')).toBe(21.5)
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
