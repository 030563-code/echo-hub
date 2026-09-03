import { describe, it, expect } from 'vitest'
import { buildDraftLines, isFittingKitLine, type RawDealLine } from '@/lib/customer-invoice/build-draft'

const kitById: RawDealLine = {
  name: 'Fitting Kit comprising 1 hook and 2 Bungies',
  hs_product_id: '57786096',
  quantity: 4,
  unit_price: 12.5,
}

describe('isFittingKitLine', () => {
  it('detects each known kit product id, even when a SKU is present', () => {
    for (const id of ['57786096', '138783', '1640211461']) {
      expect(isFittingKitLine({ hs_product_id: id, sku: 'ANY', name: 'whatever' })).toBe(true)
    }
  })

  it('falls back to the name when there is no SKU', () => {
    expect(isFittingKitLine({ name: 'Fitting Kits', hs_product_id: '999' })).toBe(true)
    expect(isFittingKitLine({ name: 'FITTING KIT (site set)', sku: '' })).toBe(true)
  })

  it('does not treat SKU-carrying non-kit lines as kits by name', () => {
    expect(isFittingKitLine({ name: 'Vertical Fitting Kit', sku: 'EBVFKNA', hs_product_id: '57786097' })).toBe(false)
    expect(isFittingKitLine({ name: 'Echo Barrier H9', sku: 'EBH9NA' })).toBe(false)
  })

  it('never splits vertical fitting kits, even the no-SKU catalogue duplicate', () => {
    expect(isFittingKitLine({ name: 'Vertical Fitting KIT ', hs_product_id: '2816078959' })).toBe(false)
    expect(isFittingKitLine({ name: 'Verticle Fitting Kit', sku: '' })).toBe(false)
  })
})

describe('buildDraftLines', () => {
  it('splits a kit into hooks (carrying the price) and double bungees at 0.00, locked to Baltimore', () => {
    const lines = buildDraftLines([kitById], 'US-SBD')
    expect(lines).toHaveLength(2)

    const [hooks, bungees] = lines
    expect(hooks.sku).toBe('HKNA')
    expect(hooks.quantity).toBe(4)
    expect(hooks.unit_price).toBe(12.5)
    expect(hooks.line_total).toBe(50)
    expect(bungees.sku).toBe('BUNNA')
    expect(bungees.quantity).toBe(8)
    expect(bungees.unit_price).toBe(0)
    expect(bungees.line_total).toBe(0)

    for (const line of lines) {
      expect(line.origin).toBe('kit_split')
      expect(line.parent_line_key).toBe('L1')
      expect(line.ship_from_depot).toBe('US-BAL')
      expect(line.ship_from_locked).toBe(true)
      expect(line.is_shipping).toBe(false)
    }
  })

  it('flags LTLNA as shipping and defaults other lines to the deal depot, unlocked', () => {
    const lines = buildDraftLines(
      [
        { name: 'Echo Barrier H9', sku: 'EBH9NA', quantity: 10, unit_price: 100 },
        { name: 'Shipping', sku: 'LTLNA', quantity: 1, unit_price: 250 },
      ],
      'US-SBD',
    )
    expect(lines[0].is_shipping).toBe(false)
    expect(lines[0].ship_from_depot).toBe('US-SBD')
    expect(lines[0].ship_from_locked).toBe(false)
    expect(lines[1].is_shipping).toBe(true)
    expect(lines[1].ship_from_depot).toBe('US-SBD')
  })

  it('carries discounts into the line total', () => {
    const [line] = buildDraftLines([{ name: 'H9', sku: 'EBH9NA', quantity: 10, unit_price: 100, discount_percentage: 15 }], 'US-BAL')
    expect(line.discount_percentage).toBe(15)
    expect(line.line_total).toBe(850)
  })

  it('passes zero-quantity and zero-price lines through instead of dropping them', () => {
    const lines = buildDraftLines(
      [
        { name: 'Mystery line', quantity: 0, unit_price: 0 },
        { name: 'Priceless', sku: 'EBH8NA', quantity: 2 },
      ],
      'US-BAL',
    )
    expect(lines).toHaveLength(2)
    expect(lines[0].quantity).toBe(0)
    expect(lines[1].unit_price).toBe(0)
  })

  it('keeps the embedded xero_item_code as a hint on 1:1 lines only', () => {
    const lines = buildDraftLines([{ name: 'H9', sku: 'EBH9NA', quantity: 1, unit_price: 1, xero_item_code: 'H9B' }, kitById], 'US-BAL')
    expect(lines[0].xero_item_code).toBe('H9B')
    expect(lines[1].xero_item_code).toBeNull()
    expect(lines[2].xero_item_code).toBeNull()
  })

  it('handles null/undefined input as an empty invoice', () => {
    expect(buildDraftLines(null, 'US-BAL')).toEqual([])
    expect(buildDraftLines(undefined, 'US-BAL')).toEqual([])
  })

  it('keeps line keys unique and sort order sequential across a mixed cart', () => {
    const lines = buildDraftLines(
      [{ name: 'H9', sku: 'EBH9NA', quantity: 1, unit_price: 1 }, kitById, { name: 'Shipping', sku: 'LTLNA', quantity: 1, unit_price: 99 }],
      'US-BAL',
    )
    const keys = lines.map((l) => l.line_key)
    expect(new Set(keys).size).toBe(keys.length)
    expect(lines.map((l) => l.sort_order)).toEqual([0, 1, 2, 3])
  })
})
