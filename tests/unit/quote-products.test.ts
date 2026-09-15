import { describe, it, expect } from 'vitest'
import { productPickableForDepot } from '@/lib/quote-products'
import { FITTING_KIT_PRODUCT_IDS } from '@/lib/customer-invoice/constants'

/**
 * The builder's product list is restricted by the depot's SKUs. The fitting kit
 * has no SKU and must still be offered: it is one line on the quote and only
 * splits into hooks and bungees after acceptance.
 */
const allowed = ['EBH9NA', 'HKNA', 'BUNNA']
const product = (id: string, name: string, sku?: string | null) => ({ id, properties: { name, hs_sku: sku } })

describe('productPickableForDepot', () => {
  it('offers a product whose SKU the depot ships, and hides one it does not', () => {
    expect(productPickableForDepot(product('1', 'Echo Barrier H9', 'EBH9NA'), allowed)).toBe(true)
    expect(productPickableForDepot(product('2', 'H9 France', 'H9-0001-FR-EN'), allowed)).toBe(false)
  })

  it('offers every fitting kit product even though none carries a SKU', () => {
    for (const id of FITTING_KIT_PRODUCT_IDS) {
      expect(productPickableForDepot(product(id, 'Fitting Kits', null), allowed), id).toBe(true)
    }
  })

  it('still hides an unrelated product with no SKU', () => {
    expect(productPickableForDepot(product('999', 'Mystery item', ''), allowed)).toBe(false)
  })

  it('restricts nothing when the depot has no SKU list', () => {
    expect(productPickableForDepot(product('999', 'Mystery item', null), [])).toBe(true)
  })
})
