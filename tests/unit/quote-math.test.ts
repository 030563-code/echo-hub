import { describe, it, expect } from 'vitest'
import { toMoney, roundCents, computeLineItemsTotal, validateLineItems, lowPriceThreshold, findSuspiciousLines } from '@/lib/quote-math'

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


describe('lowPriceThreshold', () => {
  it('is 20% of median, floored at $5, for real-priced products', () => {
    expect(lowPriceThreshold(185)).toBe(37)
    expect(lowPriceThreshold(21)).toBe(5)
  })
  it('drops the $5 floor for legitimately cheap SKUs (bungees are $0.50)', () => {
    expect(lowPriceThreshold(0.5)).toBeCloseTo(0.1)
    expect(lowPriceThreshold(1.5)).toBeCloseTo(0.3)
    expect(lowPriceThreshold(20)).toBe(4)
  })
})

describe('findSuspiciousLines', () => {
  const stats = { EBH9NA: { medianPrice: 185 } }
  it('flags the $1 placeholder mistake', () => {
    const flagged = findSuspiciousLines([{ sku: 'EBH9NA', unitPrice: 1 }], stats)
    expect(flagged).toHaveLength(1)
    expect(flagged[0]).toMatchObject({ index: 0, sku: 'EBH9NA', typicalPrice: 185 })
  })
  it('passes a genuine discount (73% of median)', () => {
    expect(findSuspiciousLines([{ sku: 'EBH9NA', unitPrice: 135 }], stats)).toHaveLength(0)
  })
  it('passes just above the threshold and flags just below', () => {
    expect(findSuspiciousLines([{ sku: 'EBH9NA', unitPrice: 37 }], stats)).toHaveLength(0)
    expect(findSuspiciousLines([{ sku: 'EBH9NA', unitPrice: 36.99 }], stats)).toHaveLength(1)
  })
  it('ignores SKUs without history and lines without a sku', () => {
    expect(findSuspiciousLines([{ sku: 'UNKNOWN', unitPrice: 1 }, { unitPrice: 1 }], stats)).toHaveLength(0)
  })
  it('passes legit cheap-accessory prices once their real median is known', () => {
    const cheap = { BUNNA: { medianPrice: 0.5 } }
    expect(findSuspiciousLines([{ sku: 'BUNNA', unitPrice: 0.5 }], cheap)).toHaveLength(0)
  })
  it('placeholder floor: flags a mapped no-history SKU at <= $5, typicalPrice null', () => {
    const flagged = findSuspiciousLines(
      [{ sku: 'EBH9WNA', unitPrice: 1 }],
      stats,
      { mappedSkus: ['EBH9WNA', 'EBH9NA'] }
    )
    expect(flagged).toHaveLength(1)
    expect(flagged[0]).toMatchObject({ sku: 'EBH9WNA', typicalPrice: null })
  })
  it('placeholder floor ignores unmapped no-history SKUs (fee lines)', () => {
    expect(
      findSuspiciousLines([{ sku: 'Transport', unitPrice: 0 }], stats, { mappedSkus: ['EBH9NA'] })
    ).toHaveLength(0)
  })
})
