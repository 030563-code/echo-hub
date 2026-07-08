import { describe, it, expect } from 'vitest'
import { isLineShort, stockShortfalls } from '@/lib/po-stock'

describe('isLineShort (the shipped per-line check)', () => {
  const stock = { EBH9NA: 100 }
  it('true only when ordered exceeds available; false for blank sku / within stock', () => {
    expect(isLineShort({ sku: 'EBH9NA', quantity: 150 }, stock)).toBe(true)
    expect(isLineShort({ sku: 'EBH9NA', quantity: 100 }, stock)).toBe(false)
    expect(isLineShort({ sku: 'MISSING', quantity: 1 }, stock)).toBe(true)
    expect(isLineShort({ sku: '', quantity: 999 }, stock)).toBe(false)
  })
})

describe('stockShortfalls', () => {
  it('flags only lines whose ordered qty exceeds available stock', () => {
    const stock = { EBH9NA: 100, EBH10NA: 0 }
    const lines = [
      { sku: 'EBH9NA', quantity: 50 }, // within stock
      { sku: 'EBH9NA', quantity: 150 }, // short
      { sku: 'EBH10NA', quantity: 1 }, // short (0 on hand)
      { sku: 'UNKNOWN', quantity: 5 }, // short (missing → 0)
      { sku: '', quantity: 999 }, // ignored (no sku)
    ]
    expect(stockShortfalls(lines, stock)).toEqual([
      { sku: 'EBH9NA', ordered: 150, available: 100 },
      { sku: 'EBH10NA', ordered: 1, available: 0 },
      { sku: 'UNKNOWN', ordered: 5, available: 0 },
    ])
  })

  it('returns nothing when every line is within stock', () => {
    expect(stockShortfalls([{ sku: 'X', quantity: 1 }], { X: 10 })).toEqual([])
  })
})
