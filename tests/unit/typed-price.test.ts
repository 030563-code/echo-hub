import { describe, it, expect } from 'vitest'
import { applyTypedPrice, priceCart, type CartLine } from '@/lib/quote-pricing'

const line: CartLine = { productId: 'p1', name: 'Echo Barrier H9', sku: 'EBH9NA', quantity: 1, unitPrice: 0 }
const LIST = 245

describe('applyTypedPrice', () => {
  it('an empty box means quote at list, NOT a zero price', () => {
    // The dangerous reading: Number('') is 0, which would be a 100% discount.
    for (const empty of [undefined, '', '   ']) {
      expect(applyTypedPrice(line, empty, LIST)).toEqual(line)
    }
  })

  it('a price below list becomes the per-unit difference', () => {
    expect(applyTypedPrice(line, '185', LIST)).toMatchObject({ discountMode: 'amount', discountValue: 60 })
  })

  it('rounds to cents, so the quote and the invoice cannot bill different nets', () => {
    expect(applyTypedPrice(line, '184.995', LIST)).toMatchObject({ discountValue: 60.01 })
  })

  it('a price at or above list clamps to no discount rather than inventing an uplift', () => {
    expect(applyTypedPrice(line, '245', LIST)).toMatchObject({ discountMode: undefined, discountValue: undefined })
    expect(applyTypedPrice(line, '300', LIST)).toMatchObject({ discountMode: undefined, discountValue: undefined })
  })

  it('leaves the line alone when there is nothing to measure against', () => {
    expect(applyTypedPrice(line, '185', null)).toEqual(line)
  })

  it('ignores junk and negatives instead of guessing', () => {
    expect(applyTypedPrice(line, 'abc', LIST)).toEqual(line)
    expect(applyTypedPrice(line, '-10', LIST)).toEqual(line)
  })

  it('replaces any percentage already on the line, it does not stack', () => {
    const withPct: CartLine = { ...line, discountMode: 'percent', discountValue: 10 }
    expect(applyTypedPrice(withPct, '185', LIST)).toMatchObject({ discountMode: 'amount', discountValue: 60 })
  })
})

describe('a typed price, priced end to end', () => {
  const listPrices = [{ sku: 'EBH9NA', currency: 'USD', unit_price: 245, floor_price: 185, is_active: true }] as never
  const cap = { max_discount_pct: null, max_discount_per_unit: 5000 }
  const run = (typed: string) =>
    priceCart({
      lines: [applyTypedPrice(line, typed, LIST)],
      currency: 'USD', companyId: null, listPrices, contractPrices: [] as never,
      cap, isSuperAdmin: false, today: '2026-09-07',
    })

  it('quotes exactly what the rep typed, down to the floor', () => {
    const r = run('185')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.lines[0].priced.netUnitPrice).toBe(185)
  })

  it('refuses a price under the floor and names the floor, not the cap', () => {
    const r = run('184')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('floor')
  })

  it('a price above list still quotes at list', () => {
    const r = run('999')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.lines[0].priced.netUnitPrice).toBe(245)
  })
})
