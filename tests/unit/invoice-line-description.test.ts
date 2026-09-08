import { describe, it, expect } from 'vitest'
import { buildDraftLines, type RawDealLine } from '@/lib/customer-invoice/build-draft'

const line = (extra: Partial<RawDealLine>): RawDealLine => ({
  name: 'Full Size Cutting Station',
  sku: 'FSCNA',
  quantity: 1,
  unit_price: 10900,
  hs_line_item_id: '58171044866',
  hs_product_id: '29231439361',
  ...extra,
})

describe('an invoice line takes the best description it can get', () => {
  it('uses the deal line description when the sync carried one', () => {
    const [built] = buildDraftLines([line({ description: "10'L x 7'W x 6'H FULL ENCLOSED" })], 'US-BAL')
    expect(built.description).toBe("10'L x 7'W x 6'H FULL ENCLOSED")
  })

  it('falls back to the Xero item description, which the sync does carry', () => {
    // line_items_raw holds xero_item_description on every line but never
    // holds description, which is why every invoice line came through blank.
    const [built] = buildDraftLines(
      [line({ xero_item_description: 'Full Size Cutting Station' })],
      'US-BAL',
    )
    expect(built.description).toBe('Full Size Cutting Station')
  })

  it('prefers the line description over the Xero one', () => {
    const [built] = buildDraftLines(
      [line({ description: 'The real thing', xero_item_description: 'Full Size Cutting Staion' })],
      'US-BAL',
    )
    expect(built.description).toBe('The real thing')
  })

  it('is null rather than empty when there is nothing to say', () => {
    const [built] = buildDraftLines([line({})], 'US-BAL')
    expect(built.description).toBeNull()
  })

  it('leaves a kit split its own explanation', () => {
    // The split line describes something the customer's quote does not show,
    // so a HubSpot description must never replace it.
    const built = buildDraftLines(
      [line({ sku: 'FKNA', name: 'Fitting Kit', quantity: 3, unit_price: 30, hs_product_id: '431850093' })],
      'US-BAL',
    )
    const split = built.filter((b) => b.origin === 'kit_split')
    if (split.length > 0) {
      for (const component of split) {
        expect(component.description).toContain('Fitting kit x 3')
      }
    }
  })
})
