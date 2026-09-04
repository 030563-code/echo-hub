/**
 * Price resolution, discounting and the caps that bound a rep's discretion.
 *
 * Every USA product in the HubSpot catalogue is still a 1.00 placeholder
 * (EBH9NA, EBH10NA, EBH8NA and V2NA all verified live at price 1, hs_price_usd
 * 1, hs_price_cad 1), so reps retype the real number from memory on every quote
 * and nothing bounds them. This module moves the price source into Supabase and
 * encodes the two decisions that come with it: which price wins, and how far a
 * rep may cut it.
 *
 * Pure by construction. No IO and no clock: "today" is a parameter, so a
 * validity window is testable and a reprice is reproducible.
 *
 * THE STORAGE RULE is the load-bearing part, because two downstream systems
 * read a discounted line and want different shapes:
 *   - deals_registry.line_items_raw feeds buildDraftLines(), which bills
 *     quantity * unit_price * (1 - discount_percentage / 100), and the pending
 *     notify_quote_accepted trigger reads COALESCE(discount_percentage, 0).
 *   - a HubSpot line item models a percentage as price + hs_discount_percentage
 *     and a per-unit money discount as price + discount.
 * So a PERCENTAGE stores the base price plus the percentage, and an AMOUNT
 * stores the NET price with a zero percentage. The amount case deliberately
 * discards the discount on the registry side: billing the net directly leaves
 * the invoice module and the Xero trigger nothing to round differently.
 * HubSpot always receives the BASE price plus whichever discount property fits.
 */

import { roundCents, toMoney } from '@/lib/quote-math'

/** 'manual' never comes out of resolveBasePrice. It is what a caller records
 *  when a rep overrides the resolved figure by hand, which stays legal while
 *  the price list is incomplete. */
export type PriceSource = 'contract' | 'list' | 'hubspot' | 'manual'

export interface ListPriceRow {
  sku: string
  currency: string
  /** MSRP (LIST). The quote builder starts a line here. */
  unit_price: number | string
  /** MAP (Advertised). Reference only: resolveBasePrice never reads it, so a
   *  rep can never be quoted at MAP by accident. */
  map_price?: number | string | null
  /** Distributor net, the floor a discount may not cross. */
  floor_price?: number | string | null
  is_active?: boolean
}

export interface ContractPriceRow {
  hubspot_company_id: string
  sku: string
  currency: string
  unit_price: number | string
  valid_from?: string | null
  valid_to?: string | null
  /** The contractor's own code for this product, e.g. Herc "H9G". Carried so a
   *  rep can match the line against the customer's purchase order. Never a
   *  lookup key: matching is on sku + currency + company, as it always was. */
  customer_part_number?: string | null
  is_active?: boolean
}

export interface DiscountCap {
  max_discount_pct?: number | string | null
  max_discount_per_unit?: number | string | null
}

export interface ResolvedPrice {
  unitPrice: number
  source: PriceSource
  floorPrice: number | null
  contractCompanyId: string | null
  /** Only ever set on a contract price, and only when the contractor gave us
   *  their own code for the product. Display only. */
  customerPartNumber?: string | null
}

const CURRENCY_SYMBOLS: Record<string, string> = { USD: '$', CAD: 'CA$', GBP: '£', EUR: '€' }

/**
 * Supabase numerics arrive as strings, and a column a select never asked for
 * arrives as undefined. Absent has to stay distinguishable from zero, because
 * a cap of 0 is a real cap that forbids every discount while a null cap column
 * means that limit simply is not set.
 */
function readNumber(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'string' && value.trim() === '') return null
  return toMoney(value)
}

/** SKUs and currency codes are typed by humans on both sides of this join. */
function norm(value: unknown): string {
  return String(value ?? '').trim().toLowerCase()
}

/** Only the calendar day decides a validity window, and yyyy-mm-dd compares
 *  correctly as a plain string. Truncating to 10 chars also survives a column
 *  that turns out to be a timestamp rather than a date. */
function day(value: unknown): string {
  return String(value ?? '').trim().slice(0, 10)
}

/** undefined means active: rows may come from a select that never asked for
 *  the column. Only an explicit false excludes a row. */
function isActive(row: { is_active?: boolean }): boolean {
  return row.is_active !== false
}

function withinWindow(row: ContractPriceRow, today: string): boolean {
  const from = day(row.valid_from)
  const to = day(row.valid_to)
  // Either bound may be missing, meaning open ended in that direction. Both
  // bounds are inclusive: a contract that starts today is live today.
  if (from !== '' && today < from) return false
  if (to !== '' && today > to) return false
  return true
}

function clampPct(value: number | null): number | null {
  return value === null ? null : Math.min(100, Math.max(0, roundCents(value)))
}

function clampAmount(value: number | null): number | null {
  return value === null ? null : Math.max(0, roundCents(value))
}

function formatPct(value: number): string {
  return `${roundCents(value)}%`
}

/**
 * Always two decimals, because a limit that reads "$30.5" looks like a bug to
 * a rep. An unknown currency prints its code rather than guessing a symbol.
 */
function formatMoney(value: number, currency = 'USD'): string {
  const code = String(currency ?? '').trim().toUpperCase()
  const amount = roundCents(value).toFixed(2)
  const symbol = CURRENCY_SYMBOLS[code]
  return symbol ? `${symbol}${amount}` : `${code} ${amount}`.trim()
}

/**
 * Which price the builder should default a line to.
 *
 * Precedence is contract > list > HubSpot catalogue. A contract price belongs
 * to a contractor company (United Rentals, HERMEQ) and only applies to that
 * company, while it is active and while today sits inside its window.
 *
 * The 'hubspot' source is the deliberate escape hatch: while Dave fills the
 * price list, a SKU with no Supabase row still quotes exactly as it does today,
 * with the rep typing the figure. Callers MUST show that source, because a
 * silent 1.00 placeholder reading as a real list price is the failure this
 * whole module exists to stop.
 */
export function resolveBasePrice(input: {
  sku: string
  currency: string
  companyId?: string | null
  contractPrices?: readonly ContractPriceRow[] | null
  listPrices?: readonly ListPriceRow[] | null
  hubspotPrice?: number | string | null
  /** ISO yyyy-mm-dd. A parameter, never Date.now(). */
  today: string
}): ResolvedPrice {
  const sku = norm(input.sku)
  const currency = norm(input.currency)
  const today = day(input.today)
  const companyId = String(input.companyId ?? '').trim()

  const listRow =
    sku === ''
      ? null
      : (input.listPrices ?? []).find(
          (row) => norm(row.sku) === sku && norm(row.currency) === currency && isActive(row),
        ) ?? null

  // The floor is the company's own commercial limit on the item, so it comes
  // from the list row even when a contract wins the price.
  const listFloor = listRow ? clampAmount(readNumber(listRow.floor_price)) : null

  let contract: ContractPriceRow | null = null
  if (sku !== '' && companyId !== '') {
    for (const row of input.contractPrices ?? []) {
      if (norm(row.sku) !== sku) continue
      if (norm(row.currency) !== currency) continue
      if (String(row.hubspot_company_id ?? '').trim() !== companyId) continue
      if (!isActive(row)) continue
      if (!withinWindow(row, today)) continue
      // Latest valid_from wins: it is the most recently negotiated price. A
      // null valid_from is open ended backwards so it sorts earliest and loses
      // to any dated row. Rows sharing a date keep the first one seen.
      if (contract === null || day(row.valid_from) > day(contract.valid_from)) contract = row
    }
  }

  if (contract !== null) {
    const unitPrice = roundCents(toMoney(contract.unit_price))
    // A contract already priced under the list floor is Dave's own deliberate
    // deal, so the floor must not veto it. Reporting no floor rather than
    // clamping keeps checkDiscount honest: there is no floor on this line, and
    // the rep is not told about a limit their base price already sits below.
    const floorPrice = listFloor !== null && unitPrice < listFloor ? null : listFloor
    return {
      unitPrice,
      source: 'contract',
      floorPrice,
      contractCompanyId: String(contract.hubspot_company_id ?? '').trim() || null,
      customerPartNumber: String(contract.customer_part_number ?? '').trim() || null,
    }
  }

  if (listRow !== null) {
    return {
      unitPrice: roundCents(toMoney(listRow.unit_price)),
      source: 'list',
      floorPrice: listFloor,
      contractCompanyId: null,
    }
  }

  return {
    unitPrice: roundCents(toMoney(input.hubspotPrice)),
    source: 'hubspot',
    floorPrice: null,
    contractCompanyId: null,
  }
}

export type DiscountMode = 'percent' | 'amount'

export interface DiscountInput {
  mode: DiscountMode
  value: number | string
}

export interface PricedLine {
  listUnitPrice: number
  netUnitPrice: number
  /** deals_registry.line_items_raw + the customer invoice draft. */
  registry: { unit_price: number; discount_percentage: number }
  /** A HubSpot line item's own properties. */
  hubspot: { price: number; hs_discount_percentage?: number; discount?: number }
}

/**
 * Turn a base price and a rep's discount entry into the three shapes that have
 * to agree: what the rep sees, what deals_registry stores, and what HubSpot is
 * sent. See the storage rule in the file docstring for why the two modes store
 * different things.
 *
 * Junk in (negative, NaN, above 100 percent, more money off than the item
 * costs) becomes a safe line rather than an exception. That split is
 * deliberate: priceLine only has to produce something storable, and
 * checkDiscount cannot say which limit stopped a rep until it has a line to
 * look at. Refusal lives there, never here.
 */
export function priceLine(basePrice: number | string, input: DiscountInput | null | undefined): PricedLine {
  // A negative base is corrupt data, not a credit note. Clamping it here means
  // no discount path can drive the net below zero later.
  const listUnitPrice = Math.max(0, roundCents(toMoney(basePrice)))
  const undiscounted: PricedLine = {
    listUnitPrice,
    netUnitPrice: listUnitPrice,
    registry: { unit_price: listUnitPrice, discount_percentage: 0 },
    hubspot: { price: listUnitPrice },
  }
  if (!input) return undiscounted

  // Quantised to 2dp up front because buildDraftLines rounds both unit_price
  // and discount_percentage the same way. Storing more precision than the
  // invoice keeps would let the invoice bill a different net than the quote
  // showed, which is the argument nobody wants to have with a customer.
  const value = roundCents(toMoney(input.value))
  if (value <= 0) return undiscounted

  if (input.mode === 'percent') {
    if (value > 100) return undiscounted
    const netUnitPrice = roundCents(listUnitPrice * (1 - value / 100))
    return {
      listUnitPrice,
      netUnitPrice,
      registry: { unit_price: listUnitPrice, discount_percentage: value },
      hubspot: { price: listUnitPrice, hs_discount_percentage: value },
    }
  }

  if (input.mode === 'amount') {
    // Free is as far as a per-unit discount can go. Passing the raw figure on
    // would have HubSpot bill a negative line.
    const perUnit = Math.min(value, listUnitPrice)
    if (perUnit <= 0) return undiscounted
    const netUnitPrice = roundCents(listUnitPrice - perUnit)
    return {
      listUnitPrice,
      netUnitPrice,
      registry: { unit_price: netUnitPrice, discount_percentage: 0 },
      hubspot: { price: listUnitPrice, discount: perUnit },
    }
  }

  return undiscounted
}

/**
 * What the line is worth at a given quantity.
 *
 * Derived from the STORED pair rather than from netUnitPrice x quantity,
 * because it has to agree to the cent with computeDraftLineTotal in the
 * customer invoice. On an amount discount the two are identical. On a
 * percentage they can differ by a cent or two at large quantities, and the
 * invoice is the document that gets paid.
 */
export function lineTotal(quantity: number | string, line: PricedLine): number {
  const qty = roundCents(toMoney(quantity))
  return roundCents(qty * line.registry.unit_price * (1 - line.registry.discount_percentage / 100))
}

/** null when the discount is allowed, otherwise a rep facing sentence naming
 *  the limit that stopped it. */
export function checkDiscount(input: {
  line: PricedLine
  cap: DiscountCap | null | undefined
  floorPrice?: number | null
  isSuperAdmin?: boolean
  /** The deal's currency, so a Canadian quote does not quote its limits in
   *  plain dollars. Defaults to USD, which is most of this pipeline. */
  currency?: string
}): string | null {
  const currency = input.currency ?? 'USD'
  const { line, cap } = input
  const perUnit = roundCents(line.listUnitPrice - line.netUnitPrice)

  // An undiscounted line is always allowed, including for a rep with no cap
  // row at all. Only an actual reduction is capped, otherwise a rep with no row
  // could not quote anything.
  if (perUnit <= 0) return null

  // Super admins bypass the caps AND the floor. Both are commercial guidance
  // for the sales team rather than product rules, and someone has to be able to
  // sign off the exception without a deploy.
  if (input.isSuperAdmin === true) return null

  const maxPct = cap ? clampPct(readNumber(cap.max_discount_pct)) : null
  const maxAmount = cap ? clampAmount(readNumber(cap.max_discount_per_unit)) : null

  // No cap row, or a row with both columns null, means no discretion at all.
  // Defaulting to unlimited here would hand every unconfigured rep a blank
  // cheque, so absence is the strict case, not the lenient one.
  if (maxPct === null && maxAmount === null) return 'You are not allowed to apply a discount'

  // Both caps are checked against the effective discount whatever mode the rep
  // typed, so a 10 percent rep cannot route around the cap by entering the same
  // cut as a cash amount. Percentage is reported first because it is the limit
  // reps are actually taught.
  const effectivePct = line.listUnitPrice > 0 ? roundCents((perUnit / line.listUnitPrice) * 100) : 0
  if (maxPct !== null && effectivePct > maxPct) {
    return `Discount of ${formatPct(effectivePct)} is above your limit of ${formatPct(maxPct)}`
  }
  if (maxAmount !== null && perUnit > maxAmount) {
    return `A discount of ${formatMoney(perUnit, currency)} per unit is above your limit of ${formatMoney(maxAmount, currency)} per unit`
  }

  const floor = input.floorPrice ?? null
  if (floor !== null && line.netUnitPrice < roundCents(floor)) {
    return `That price is below the ${formatMoney(floor, currency)} floor for this item`
  }

  return null
}

/** A short rep facing summary of a cap, for the line under the cart. */
export function describeCap(cap: DiscountCap | null | undefined, currency: string): string {
  const maxPct = cap ? clampPct(readNumber(cap.max_discount_pct)) : null
  const maxAmount = cap ? clampAmount(readNumber(cap.max_discount_per_unit)) : null

  const parts: string[] = []
  if (maxPct !== null) parts.push(formatPct(maxPct))
  // "or" is the owner's wording. Both caps in fact have to hold, and
  // checkDiscount enforces whichever bites first, but the tighter phrasing
  // reads as legalese on a line under a cart.
  if (maxAmount !== null) parts.push(`${formatMoney(maxAmount, currency)} per unit`)

  // A missing row and a row with both columns null are the same thing to a rep.
  if (parts.length === 0) return 'You cannot apply a discount'
  return `Your limit: ${parts.join(' or ')}`
}
