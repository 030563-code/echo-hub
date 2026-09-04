/**
 * Pure draft-invoice builder: maps deals_registry.line_items_raw into
 * customer_invoice_lines inputs, applying the fitting-kit split and the
 * shipping flag. No IO, fully unit-tested.
 */

import { roundCents, toMoney } from '@/lib/quote-math'
import {
  FITTING_KIT_COMPONENTS,
  FITTING_KIT_PRODUCT_IDS,
  KIT_SHIP_FROM,
  SHIPPING_SKUS,
  type USDepot,
} from '@/lib/customer-invoice/constants'

/** Shape of one entry in deals_registry.line_items_raw (snake_case, written by
 *  the Hub's createQuote and by n8n's HubSpot sync; every field may be absent
 *  on legacy rows). */
export interface RawDealLine {
  name?: string
  sku?: string
  quantity?: number | string
  unit_price?: number | string
  total_amount?: number | string
  discount_percentage?: number | string
  hs_product_id?: string
  hs_line_item_id?: string
  description?: string
  xero_item_code?: string
  /** Stamped by Supabase's split_fitting_kit_lines() on a kit component: the
   *  identity of the kit line it came out of. Its presence is what marks the
   *  line as already split. */
  kit_parent_line_key?: string
  origin?: string
  /** Kit components carry their own dispatch depot (Baltimore), which is not
   *  necessarily the deal's. */
  ship_from_depot?: string
}

export interface DraftLineInput {
  line_key: string
  sort_order: number
  origin: 'hubspot' | 'kit_split' | 'manual'
  parent_line_key: string | null
  hs_line_item_id: string | null
  hs_product_id: string | null
  sku: string | null
  xero_item_code: string | null
  account_code: string | null
  name: string
  description: string | null
  quantity: number
  unit_price: number
  discount_percentage: number
  line_total: number
  is_shipping: boolean
  ship_from_depot: USDepot
  ship_from_locked: boolean
}

/** True once Supabase has already split this line into hooks and bungees. */
export function isKitComponentLine(line: RawDealLine): boolean {
  return String(line.kit_parent_line_key ?? '').trim() !== ''
}

/** A line is a fitting kit when its HubSpot product id is one of the known kit
 *  products, or (catalogue duplicates carry no SKU) when it has no SKU and the
 *  name says "fitting kit". Vertical fitting kits (VFK/EBVFKNA, incl. a no-SKU
 *  catalogue duplicate) are a distinct product and are never split. */
export function isFittingKitLine(line: RawDealLine): boolean {
  // A component Supabase already produced is NEVER a kit, even though it
  // inherits the kit's hs_product_id. Without this guard the product-id test
  // below matches the hook and the bungee line, and each splits AGAIN into a
  // hook and bungees: four lines, and the kit's money allocated twice.
  if (isKitComponentLine(line)) return false
  const productId = String(line.hs_product_id ?? '')
  if (FITTING_KIT_PRODUCT_IDS.has(productId)) return true
  const sku = String(line.sku ?? '').trim()
  const name = String(line.name ?? '')
  return sku === '' && /fitting\s*kit/i.test(name) && !/vertic/i.test(name)
}

/**
 * Per-unit prices for a kit's components, preserving the kit price exactly.
 *
 * Mirrors public.split_fitting_kit_lines() in Supabase: every component rounds
 * to the cent and the one flagged takesRemainder absorbs what is left, so
 * hook + 2 x bungee is exactly the kit unit price.
 */
export function fittingKitUnitPrices(kitUnitPrice: number): number[] {
  const prices = FITTING_KIT_COMPONENTS.map((c) =>
    c.takesRemainder ? 0 : roundCents((kitUnitPrice * c.shareOfKit) / c.qtyPerKit),
  )
  const allocated = FITTING_KIT_COMPONENTS.reduce(
    (sum, c, i) => (c.takesRemainder ? sum : sum + prices[i] * c.qtyPerKit),
    0,
  )
  const remainderIndex = FITTING_KIT_COMPONENTS.findIndex((c) => c.takesRemainder)
  if (remainderIndex >= 0) {
    const c = FITTING_KIT_COMPONENTS[remainderIndex]
    prices[remainderIndex] = roundCents((kitUnitPrice - allocated) / c.qtyPerKit)
  }
  return prices
}

export function computeDraftLineTotal(quantity: number, unitPrice: number, discountPct: number): number {
  return roundCents(quantity * unitPrice * (1 - discountPct / 100))
}

/**
 * Build editable draft-invoice lines from a deal's raw quote lines.
 *
 * - Fitting-kit lines split into 1 hook and 2 bungees per kit, the money going
 *   75% to the hook and 12.5% to each bungee, both locked to Baltimore. Since
 *   migration 20260904110000 Supabase does this on the way into deals_registry,
 *   so in practice this branch now only runs for rows written before it; lines
 *   already split arrive carrying kit_parent_line_key and are passed through as
 *   components rather than split a second time.
 * - LTLNA lines become shipping lines (TaxJar `shipping`, not a taxable item).
 * - Everything else maps 1:1, dispatching from the deal's depot by default.
 * - The embedded xero_item_code is carried as a hint only; the save path
 *   re-resolves it against product_depot_mapping for the line's own ship-from
 *   depot (the registry enrichment assumed the deal depot).
 * - Nothing is dropped silently: zero-qty and zero-price lines pass through
 *   for the reviewer to fix or remove.
 */
export function buildDraftLines(rawLines: readonly RawDealLine[] | null | undefined, dealDepot: USDepot): DraftLineInput[] {
  const out: DraftLineInput[] = []
  const lines = Array.isArray(rawLines) ? rawLines : []

  lines.forEach((raw, index) => {
    const baseKey = `L${index + 1}`
    // Quantize to the precision the columns actually store (numeric(12,2)) so
    // the persisted line_total always equals qty x price on the stored values;
    // raw HubSpot figures can carry more decimals than that.
    const quantity = roundCents(toMoney(raw.quantity))
    const unitPrice = roundCents(toMoney(raw.unit_price))
    const discount = roundCents(toMoney(raw.discount_percentage))
    const sku = String(raw.sku ?? '').trim() || null

    if (isFittingKitLine(raw)) {
      const componentPrices = fittingKitUnitPrices(unitPrice)
      FITTING_KIT_COMPONENTS.forEach((component, ci) => {
        const componentQty = quantity * component.qtyPerKit
        const componentPrice = componentPrices[ci]
        out.push({
          line_key: `${baseKey}-${component.sku}`,
          sort_order: out.length,
          origin: 'kit_split',
          parent_line_key: baseKey,
          hs_line_item_id: raw.hs_line_item_id ?? null,
          hs_product_id: raw.hs_product_id ?? null,
          sku: component.sku,
          xero_item_code: null,
          account_code: null,
          name: component.name,
          description:
            ci === 0
              ? `Fitting kit x ${quantity} (1 hook + 2 bungees per kit)${raw.description ? `. ${raw.description}` : ''}`
              : `Fitting kit x ${quantity} (1 hook + 2 bungees per kit)`,
          quantity: componentQty,
          unit_price: componentPrice,
          discount_percentage: discount,
          line_total: computeDraftLineTotal(componentQty, componentPrice, discount),
          is_shipping: false,
          ship_from_depot: KIT_SHIP_FROM,
          ship_from_locked: true,
        })
      })
      return
    }

    // A component Supabase already split out arrives here as an ordinary line.
    // It still has to behave like a kit component in the editor: pinned to
    // Baltimore, so its tax is calculated from the depot it actually ships
    // from, and flagged kit_split so save-draft keeps that pin.
    const kitComponent = isKitComponentLine(raw)
    const isShipping = sku !== null && SHIPPING_SKUS.has(sku)
    out.push({
      line_key: baseKey,
      sort_order: out.length,
      origin: kitComponent ? 'kit_split' : 'hubspot',
      parent_line_key: kitComponent ? String(raw.kit_parent_line_key).trim() : null,
      hs_line_item_id: raw.hs_line_item_id ?? null,
      hs_product_id: raw.hs_product_id ?? null,
      sku,
      xero_item_code: String(raw.xero_item_code ?? '').trim() || null,
      account_code: null,
      name: String(raw.name ?? '').trim() || sku || 'Line item',
      description: String(raw.description ?? '').trim() || null,
      quantity,
      unit_price: unitPrice,
      discount_percentage: discount,
      line_total: computeDraftLineTotal(quantity, unitPrice, discount),
      is_shipping: isShipping,
      ship_from_depot: kitComponent ? KIT_SHIP_FROM : dealDepot,
      ship_from_locked: kitComponent,
    })
  })

  return out
}
