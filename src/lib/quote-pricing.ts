/**
 * Pricing a whole cart: one function the builder and the server both run.
 *
 * The browser needs it to show a rep what a line costs and why it is refused;
 * createQuote needs it to decide what actually gets written. Running the same
 * pure function on both sides is what stops the UI promising a discount the
 * server then rejects, and stops a crafted request naming its own price.
 *
 * The server passes the SAME Supabase rows it read itself. The client's
 * unitPrice is used for exactly one case, a SKU with no list price at all,
 * which is today's behaviour and stays legal while Dave fills the price list.
 */

import {
  checkDiscount,
  lineTotal,
  priceLine,
  resolveBasePrice,
  type ContractPriceRow,
  type DiscountCap,
  type DiscountInput,
  type DiscountMode,
  type ListPriceRow,
  type PriceSource,
  type PricedLine,
} from '@/lib/pricing'
import { roundCents, toMoney } from '@/lib/quote-math'

export interface CartLine {
  productId: string
  name: string
  quantity: number
  sku?: string
  description?: string
  /** What the rep typed. Honoured ONLY when no Supabase price exists for the
   *  SKU, which is why a line's source has to be resolved before it is read. */
  unitPrice: number
  discountMode?: DiscountMode
  discountValue?: number
}

export interface PricedCartLine {
  productId: string
  name: string
  quantity: number
  sku?: string
  description?: string
  priced: PricedLine
  priceSource: PriceSource
  contractCompanyId: string | null
  /** The customer's own code for this product on a contract-priced line, so a
   *  rep can tie the line to the purchase order in front of them. Display only,
   *  and never set on a list or manual line. */
  customerPartNumber: string | null
  floorPrice: number | null
  lineTotal: number
}

export interface PriceCartInput {
  lines: readonly CartLine[]
  currency: string
  companyId?: string | null
  listPrices?: readonly ListPriceRow[] | null
  contractPrices?: readonly ContractPriceRow[] | null
  cap?: DiscountCap | null
  isSuperAdmin?: boolean
  /** ISO yyyy-mm-dd. A parameter so a validity window is reproducible. */
  today: string
}

export type PriceCartResult =
  | { ok: true; lines: PricedCartLine[]; total: number }
  | { ok: false; error: string; lineIndex: number }

/**
 * Price and check every line, refusing on the first problem.
 *
 * Refusing the whole cart rather than dropping a line is deliberate: a quote
 * silently missing an item is worse than one that will not generate, because
 * the rep sends it before noticing.
 */
export function priceCart(input: PriceCartInput): PriceCartResult {
  const out: PricedCartLine[] = []

  for (let i = 0; i < input.lines.length; i++) {
    const line = input.lines[i]
    const resolved = resolveBasePrice({
      sku: String(line.sku ?? ''),
      currency: input.currency,
      companyId: input.companyId ?? null,
      contractPrices: input.contractPrices,
      listPrices: input.listPrices,
      // Only consulted when nothing in Supabase matches, and then it is what
      // the rep typed rather than the HubSpot catalogue placeholder.
      hubspotPrice: line.unitPrice,
      today: input.today,
    })

    // A SKU with no Supabase row keeps today's behaviour: the rep names the
    // price. It is recorded as 'manual' rather than 'hubspot' because the
    // number came from a person, and the builder shows that so a placeholder
    // can never be mistaken for a real list price.
    const source: PriceSource = resolved.source === 'hubspot' ? 'manual' : resolved.source

    const discount: DiscountInput | null =
      line.discountMode && toMoney(line.discountValue) > 0
        ? { mode: line.discountMode, value: toMoney(line.discountValue) }
        : null

    // A manual line has no base to discount FROM, so a percentage off a number
    // the rep just invented is theatre. They can simply type the lower price.
    if (source === 'manual' && discount) {
      return {
        ok: false,
        lineIndex: i,
        error: `Line ${i + 1} (${line.name}) has no list price, so there is nothing to discount from. Type the price you want to charge instead.`,
      }
    }

    const priced = priceLine(resolved.unitPrice, discount)
    const refusal = checkDiscount({
      line: priced,
      cap: input.cap,
      floorPrice: resolved.floorPrice,
      isSuperAdmin: input.isSuperAdmin,
      currency: input.currency,
    })
    if (refusal) {
      return { ok: false, lineIndex: i, error: `Line ${i + 1} (${line.name}): ${refusal}` }
    }

    out.push({
      productId: line.productId,
      name: line.name,
      quantity: line.quantity,
      sku: line.sku,
      description: line.description,
      priced,
      priceSource: source,
      contractCompanyId: resolved.contractCompanyId,
      customerPartNumber: resolved.customerPartNumber ?? null,
      floorPrice: resolved.floorPrice,
      lineTotal: lineTotal(line.quantity, priced),
    })
  }

  return { ok: true, lines: out, total: roundCents(out.reduce((sum, l) => sum + l.lineTotal, 0)) }
}

/**
 * One element of deals_registry.line_items_raw.
 *
 * Every key the system already reads is kept: buildDraftLines, the pending
 * notify_quote_accepted trigger and the MRP demand engine all index this shape,
 * and the BEFORE trigger on deals_registry merges its Xero fields into each
 * element rather than rebuilding it, so the new keys survive.
 */
export function toRegistryLine(
  line: PricedCartLine,
  hsLineItemId?: string,
): Record<string, unknown> {
  return {
    name: line.name,
    sku: line.sku,
    quantity: line.quantity,
    // The pair the customer invoice bills with. For a percentage this is the
    // base plus the percentage; for a cash discount it is the net with a zero
    // percentage, so nothing downstream can round the discount differently.
    unit_price: line.priced.registry.unit_price,
    discount_percentage: line.priced.registry.discount_percentage,
    total_amount: line.lineTotal,
    hs_product_id: line.productId,
    // Kept for the pricing audit: what the item lists at, and where the number
    // the rep started from came from.
    list_unit_price: line.priced.listUnitPrice,
    price_source: line.priceSource,
    ...(line.contractCompanyId ? { contract_company_id: line.contractCompanyId } : {}),
    ...(hsLineItemId ? { hs_line_item_id: hsLineItemId } : {}),
    ...(line.description ? { description: line.description } : {}),
  }
}
