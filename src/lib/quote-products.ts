import { FITTING_KIT_PRODUCT_IDS } from '@/lib/customer-invoice/constants'

/**
 * Which catalogue products a rep may put on a quote for a depot.
 *
 * The depot restriction is by SKU: product_depot_mapping says which SKUs each
 * depot ships. The fitting kit is sold as ONE line and carries no SKU of its
 * own, so the SKU rule alone hid it, and on 15 Sep 2026 Jillian could only
 * find its hooks and bungees as two separate lines, which is what went out on
 * her quote until she rewrote it in HubSpot by hand. Dean: the quote shows the
 * regular fitting kit; the split into a hook and two bungees happens after
 * acceptance, on the invoice and in Xero, never on the quote.
 */
export interface PickableProduct {
  id: string
  properties: { name: string; hs_sku?: string | null }
}

export function productPickableForDepot(product: PickableProduct, allowedSkus: readonly string[]): boolean {
  if (allowedSkus.length === 0) return true
  const sku = String(product.properties.hs_sku ?? '').trim()
  if (sku !== '') return allowedSkus.includes(sku)
  return FITTING_KIT_PRODUCT_IDS.has(String(product.id))
}
