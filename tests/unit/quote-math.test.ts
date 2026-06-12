import { describe, it, expect } from 'vitest'
import { toMoney, roundCents, computeLineItemsTotal } from '@/lib/quote-math'

describe('toMoney', () => {
  it('coerces numeric strings and guards NaN/undefined/null', () => {
    expect(toMoney(12.5)).toBe(12.5)
    expect(toMoney('12.5')).toBe(12.5)
    expect(toMoney(undefined)).toBe(0)
    expect(toMoney(null)).toBe(0)
    expect(toMoney('not a number')).toBe(0)
    expect(toMoney(NaN)).toBe(0)
  })
})

describe('roundCents', () => {
  it('rounds to two decimal places without float drift', () => {
    expect(roundCents(0.1 + 0.2)).toBe(0.3)
    expect(roundCents(1.005)).toBe(1.01)
    expect(roundCents(2.675)).toBe(2.68)
  })
})

describe('computeLineItemsTotal (finding #10 — server recomputes amount)', () => {
  it('sums explicit line totals', () => {
    expect(computeLineItemsTotal([{ total: 10 }, { total: 5.5 }, { total: 0.25 }])).toBe(15.75)
  })

  it('falls back to quantity × unitPrice when total is absent', () => {
    expect(computeLineItemsTotal([{ quantity: 3, unitPrice: 2 }, { quantity: 2, unitPrice: 1.5 }])).toBe(9)
  })

  it('never returns NaN when HubSpot fields are null/garbage', () => {
    const result = computeLineItemsTotal([
      { total: null },
      { quantity: null, unitPrice: null },
      { total: 'abc' as unknown as number },
      { total: 4 },
    ])
    expect(result).toBe(4)
    expect(Number.isNaN(result)).toBe(false)
  })

  it('handles empty / nullish input', () => {
    expect(computeLineItemsTotal([])).toBe(0)
    expect(computeLineItemsTotal(null)).toBe(0)
    expect(computeLineItemsTotal(undefined)).toBe(0)
  })
})
