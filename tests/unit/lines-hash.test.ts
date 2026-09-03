import { describe, it, expect } from 'vitest'
import { linesHash, sourceLinesHash, type TaxRelevantHeader, type TaxRelevantLine } from '@/lib/customer-invoice/hash'

const header: TaxRelevantHeader = {
  delivery_street: '1218 Broadway',
  delivery_city: 'Santa Monica',
  delivery_state: 'CA',
  delivery_zip: '90404',
  taxjar_customer_id: 'US123',
  is_collection: false,
}

const lineA: TaxRelevantLine = {
  line_key: 'L1',
  sku: 'EBH9NA',
  quantity: 10,
  unit_price: 100,
  discount_percentage: 0,
  is_shipping: false,
  ship_from_depot: 'US-BAL',
}

describe('linesHash', () => {
  it('changes when the collection flag flips', () => {
    const delivered = linesHash([lineA], { ...header, is_collection: false })
    const collected = linesHash([lineA], { ...header, is_collection: true })
    expect(delivered).not.toBe(collected)
    // Each must also be stable, so the difference is the flag and not noise.
    expect(linesHash([lineA], { ...header, is_collection: false })).toBe(delivered)
    expect(linesHash([lineA], { ...header, is_collection: true })).toBe(collected)
  })

  it('does not collapse an undefined flag onto a third value', () => {
    // JSON.stringify drops an undefined key, so without the `=== true`
    // coercion an untyped caller would reproduce the pre-collection hash and
    // the staleness guard would accept a hash never computed for this invoice.
    const withoutFlag: Partial<TaxRelevantHeader> = { ...header }
    delete withoutFlag.is_collection
    expect(linesHash([lineA], withoutFlag as TaxRelevantHeader)).toBe(
      linesHash([lineA], { ...header, is_collection: false }),
    )
  })

  it('keeps the flag independent of the delivery address', () => {
    // A collected invoice legitimately has no address. Clearing the address
    // must not make the collected and delivered hashes converge.
    const cleared = {
      ...header,
      delivery_street: null,
      delivery_city: null,
      delivery_state: null,
      delivery_zip: null,
    }
    expect(linesHash([lineA], { ...cleared, is_collection: true })).not.toBe(
      linesHash([lineA], { ...cleared, is_collection: false }),
    )
  })

  it('is stable across line ordering', () => {
    const lineB: TaxRelevantLine = { ...lineA, line_key: 'L2', sku: 'LTLNA', is_shipping: true }
    expect(linesHash([lineA, lineB], header)).toBe(linesHash([lineB, lineA], header))
  })

  it('changes when a tax-relevant field changes', () => {
    const base = linesHash([lineA], header)
    expect(linesHash([{ ...lineA, quantity: 11 }], header)).not.toBe(base)
    expect(linesHash([{ ...lineA, unit_price: 99 }], header)).not.toBe(base)
    expect(linesHash([{ ...lineA, discount_percentage: 5 }], header)).not.toBe(base)
    expect(linesHash([{ ...lineA, ship_from_depot: 'US-SBD' }], header)).not.toBe(base)
    expect(linesHash([{ ...lineA, is_shipping: true }], header)).not.toBe(base)
    expect(linesHash([lineA], { ...header, delivery_zip: '90405' })).not.toBe(base)
    expect(linesHash([lineA], { ...header, taxjar_customer_id: null })).not.toBe(base)
  })

  it('treats null and empty header fields the same, so cosmetic edits stay cheap', () => {
    const withNulls = { ...header, taxjar_customer_id: null }
    const withEmpty = { ...header, taxjar_customer_id: '' }
    expect(linesHash([lineA], withNulls as TaxRelevantHeader)).toBe(linesHash([lineA], withEmpty as TaxRelevantHeader))
  })
})

describe('sourceLinesHash', () => {
  it('is order-sensitive and change-sensitive over the raw snapshot', () => {
    const a = [{ sku: 'EBH9NA', quantity: 1 }]
    const b = [{ sku: 'EBH9NA', quantity: 2 }]
    expect(sourceLinesHash(a)).not.toBe(sourceLinesHash(b))
    expect(sourceLinesHash([a[0], b[0]])).not.toBe(sourceLinesHash([b[0], a[0]]))
    expect(sourceLinesHash(a)).toBe(sourceLinesHash([{ sku: 'EBH9NA', quantity: 1 }]))
  })
})
