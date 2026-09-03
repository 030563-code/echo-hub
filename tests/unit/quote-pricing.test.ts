import { describe, it, expect } from 'vitest'
import { priceCart, toRegistryLine, type CartLine } from '@/lib/quote-pricing'
import { buildDraftLines } from '@/lib/customer-invoice/build-draft'
import type { ContractPriceRow, ListPriceRow } from '@/lib/pricing'

const TODAY = '2026-09-03'
const UR = '45934040176'

const listPrices: ListPriceRow[] = [
  { sku: 'EBH9NA', currency: 'USD', unit_price: 178, floor_price: 150 },
  { sku: 'LTLNA', currency: 'USD', unit_price: 1200 },
]
const contractPrices: ContractPriceRow[] = [
  { hubspot_company_id: UR, sku: 'EBH9NA', currency: 'USD', unit_price: 160 },
]

const line = (over: Partial<CartLine> = {}): CartLine => ({
  productId: '1640186928', name: 'Echo Barrier H9', quantity: 499, sku: 'EBH9NA', unitPrice: 1, ...over,
})

const base = { currency: 'USD', listPrices, today: TODAY }

describe('priceCart resolves the price the SERVER decides, not the one sent', () => {
  it('ignores the browser unit price when a list price exists', () => {
    // The whole point. A crafted request naming 5.00 for an item that lists at
    // 178 must not be able to sell it at 5.00.
    const result = priceCart({ ...base, lines: [line({ unitPrice: 5 })] })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.lines[0].priced.listUnitPrice).toBe(178)
    expect(result.lines[0].priceSource).toBe('list')
    expect(result.total).toBe(88822)
  })

  it('prefers the customer contract price and records which customer it came from', () => {
    const result = priceCart({ ...base, companyId: UR, contractPrices, lines: [line()] })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.lines[0].priced.listUnitPrice).toBe(160)
    expect(result.lines[0].priceSource).toBe('contract')
    expect(result.lines[0].contractCompanyId).toBe(UR)
  })

  it('lets the rep name the price for a SKU nobody has priced yet', () => {
    // The rollout case: the price list starts empty and quoting must not stop.
    const result = priceCart({ ...base, lines: [line({ sku: 'NEWSKU', unitPrice: 42, quantity: 2 })] })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.lines[0].priceSource).toBe('manual')
    expect(result.lines[0].priced.netUnitPrice).toBe(42)
    expect(result.total).toBe(84)
  })

  it('refuses a discount on a manual line, because there is no base to discount from', () => {
    const result = priceCart({
      ...base,
      cap: { max_discount_pct: 50 },
      lines: [line({ sku: 'NEWSKU', unitPrice: 42, discountMode: 'percent', discountValue: 10 })],
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toMatch(/nothing to discount from/)
  })
})

describe('priceCart enforces the cap', () => {
  it('refuses the WHOLE cart, naming the line, rather than dropping one item', () => {
    // A quote silently missing an item is worse than one that will not
    // generate: the rep sends it before noticing.
    const result = priceCart({
      ...base,
      cap: { max_discount_pct: 10 },
      lines: [line(), line({ name: 'LTL Freight', sku: 'LTLNA', quantity: 1, discountMode: 'percent', discountValue: 25 })],
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.lineIndex).toBe(1)
    expect(result.error).toContain('Line 2 (LTL Freight)')
    expect(result.error).toMatch(/above your limit of 10%/)
  })

  it('refuses a rep with no cap row who tries to discount at all', () => {
    const result = priceCart({ ...base, lines: [line({ discountMode: 'percent', discountValue: 5 })] })
    expect(result.ok).toBe(false)
  })

  it('honours the SKU floor even when the percentage cap allows it', () => {
    const result = priceCart({
      ...base,
      cap: { max_discount_pct: 90 },
      lines: [line({ discountMode: 'percent', discountValue: 50 })],
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toMatch(/floor/)
  })

  it('lets a super admin through', () => {
    const result = priceCart({
      ...base,
      isSuperAdmin: true,
      lines: [line({ discountMode: 'percent', discountValue: 50 })],
    })
    expect(result.ok).toBe(true)
  })

  it('treats a zero or absent discount as no discount at all', () => {
    for (const over of [{}, { discountMode: 'percent' as const, discountValue: 0 }]) {
      const result = priceCart({ ...base, lines: [line(over)] })
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.lines[0].priced.registry.discount_percentage).toBe(0)
    }
  })
})

describe('toRegistryLine keeps every key the rest of the system reads', () => {
  const priced = priceCart({
    ...base,
    cap: { max_discount_pct: 10 },
    lines: [line({ discountMode: 'percent', discountValue: 10, description: 'Sound barrier' })],
  })

  it('carries the legacy keys the trigger and the MRP engine index', () => {
    expect(priced.ok).toBe(true)
    if (!priced.ok) return
    const row = toRegistryLine(priced.lines[0], '58524386438')
    expect(row).toMatchObject({
      name: 'Echo Barrier H9',
      sku: 'EBH9NA',
      quantity: 499,
      unit_price: 178,
      discount_percentage: 10,
      total_amount: 79939.8,
      hs_product_id: '1640186928',
      hs_line_item_id: '58524386438',
      description: 'Sound barrier',
    })
  })

  it('adds the pricing audit keys without disturbing the old ones', () => {
    if (!priced.ok) return
    const row = toRegistryLine(priced.lines[0])
    expect(row.list_unit_price).toBe(178)
    expect(row.price_source).toBe('list')
    // Omitted rather than null, so a non-contract line does not claim a company.
    expect('contract_company_id' in row).toBe(false)
    expect('hs_line_item_id' in row).toBe(false)
  })

  it('stores unit_price as the BASE, so the customer invoice bills the same net', () => {
    // buildDraftLines is what actually raises the invoice. If it disagrees with
    // the quote by a cent, the argument happens in front of the customer.
    if (!priced.ok) return
    const row = toRegistryLine(priced.lines[0])
    const [draft] = buildDraftLines([row], 'US-BAL')
    expect(draft.unit_price).toBe(178)
    expect(draft.discount_percentage).toBe(10)
    expect(draft.line_total).toBe(priced.lines[0].lineTotal)
  })

  it('stores a CASH discount as the exact net with no percentage, and the invoice agrees', () => {
    const cash = priceCart({
      ...base,
      cap: { max_discount_per_unit: 20 },
      lines: [line({ discountMode: 'amount', discountValue: 11.11 })],
    })
    expect(cash.ok).toBe(true)
    if (!cash.ok) return
    const row = toRegistryLine(cash.lines[0])
    expect(row.unit_price).toBe(166.89)
    expect(row.discount_percentage).toBe(0)
    const [draft] = buildDraftLines([row], 'US-BAL')
    expect(draft.line_total).toBe(cash.lines[0].lineTotal)
  })
})
