import { describe, it, expect } from 'vitest'
import { toMoney, roundCents, computeLineItemsTotal, validateLineItems } from '@/lib/quote-math'

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
  it('derives each line from quantity × unitPrice', () => {
    expect(computeLineItemsTotal([{ quantity: 3, unitPrice: 2 }, { quantity: 2, unitPrice: 1.5 }])).toBe(9)
  })

  it('IGNORES a client-supplied total that disagrees with quantity × unitPrice', () => {
    // The whole point of finding #10: a crafted request cannot name its own
    // line total. 54 × 245 = 13230 regardless of what the browser claims.
    expect(computeLineItemsTotal([{ quantity: 54, unitPrice: 245, total: 1 }])).toBe(13230)
    expect(computeLineItemsTotal([{ quantity: 1, unitPrice: 10, total: 999999 }])).toBe(10)
  })

  it('never returns NaN when HubSpot fields are null/garbage', () => {
    const result = computeLineItemsTotal([
      { total: null },
      { quantity: null, unitPrice: null },
      { total: 'abc' as unknown as number },
      { quantity: 2, unitPrice: 2 },
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

describe('validateLineItems (server-side pre-HubSpot-write guard)', () => {
  it('accepts a list of valid items', () => {
    expect(
      validateLineItems([
        { quantity: 1, unitPrice: 0 },
        { quantity: 3, unitPrice: 12.5 },
      ])
    ).toBeNull()
  })

  it('rejects a negative unit price and names the offending item', () => {
    const result = validateLineItems([
      { quantity: 1, unitPrice: 10 },
      { quantity: 2, unitPrice: -5 },
    ])
    expect(result).not.toBeNull()
    expect(result).toContain('Line item 2')
  })

  it('rejects a zero quantity', () => {
    const result = validateLineItems([{ quantity: 0, unitPrice: 10 }])
    expect(result).not.toBeNull()
    expect(result).toContain('Line item 1')
  })

  it('rejects a negative quantity', () => {
    const result = validateLineItems([{ quantity: -2, unitPrice: 10 }])
    expect(result).not.toBeNull()
    expect(result).toContain('Line item 1')
  })

  it('rejects a fractional quantity', () => {
    const result = validateLineItems([{ quantity: 1.5, unitPrice: 10 }])
    expect(result).not.toBeNull()
    expect(result).toContain('Line item 1')
  })

  it('rejects a NaN quantity', () => {
    const result = validateLineItems([{ quantity: NaN, unitPrice: 10 }])
    expect(result).not.toBeNull()
    expect(result).toContain('Line item 1')
  })

  it('treats an empty array as valid — the length > 0 gate lives elsewhere', () => {
    expect(validateLineItems([])).toBeNull()
  })
})
