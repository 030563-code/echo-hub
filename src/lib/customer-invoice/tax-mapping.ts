/**
 * Pure request/response mapping between draft-invoice lines and TaxJar's
 * /v2/taxes endpoint. TaxJar accepts a single from_ address per call, so lines
 * are grouped by ship-from depot and one request is built per group; each
 * group carries its own shipping total. No IO here — the server action in
 * src/app/actions/invoicing/calculate-tax.ts owns the HTTP and persistence.
 */

import { roundCents } from '@/lib/quote-math'
import {
  DEPOT_FROM_ADDRESSES,
  US_DEPOTS,
  US_REGISTERED_STATES,
  type USDepot,
} from '@/lib/customer-invoice/constants'

export interface TaxableLine {
  line_key: string
  quantity: number
  unit_price: number
  discount_percentage: number
  line_total: number
  is_shipping: boolean
  ship_from_depot: USDepot
}

export interface TaxJarLineItem {
  id: string
  quantity: number
  unit_price: number
  discount?: number
}

export interface TaxJarTaxRequest {
  from_country: string
  from_state: string
  from_zip: string
  from_city?: string
  from_street?: string
  to_country: string
  to_state: string
  to_zip: string
  to_city?: string
  to_street?: string
  shipping: number
  customer_id?: string
  line_items: TaxJarLineItem[]
}

export interface TaxJarLineBreakdown {
  id: string | number
  tax_collectable?: number
  taxable_amount?: number
  combined_tax_rate?: number
}

export interface TaxJarTaxResponse {
  tax: {
    amount_to_collect?: number
    taxable_amount?: number
    rate?: number
    has_nexus?: boolean
    freight_taxable?: boolean
    exemption_type?: string
    /** Where TaxJar decided the sale happened. Shown to the reviewer: a bad
     *  zip returns a different number rather than an error, so the resolved
     *  place is the check, not the rate. */
    jurisdictions?: {
      country?: string
      state?: string
      county?: string
      city?: string
    }
    tax_source?: string
    breakdown?: {
      shipping?: { tax_collectable?: number }
      line_items?: TaxJarLineBreakdown[]
    }
  }
}

export interface ShipToAddress {
  street: string
  city: string
  state: string
  zip: string
}

export interface TaxRequestGroup {
  depot: USDepot
  request: TaxJarTaxRequest
  taxableLineKeys: string[]
  shippingLineKeys: string[]
}

export type BuildTaxRequestsResult =
  | { ok: true; groups: TaxRequestGroup[] }
  | { ok: false; error: string }

/**
 * `isCollection` is Will Call: the customer picks the goods up, so the sale is
 * taxed where the depot is, not where the customer is. Because requests are
 * already partitioned by ship-from depot, that just makes each group's
 * destination its own origin. `shipTo` is therefore nullable: a collected
 * invoice needs no delivery address at all.
 */
export function buildTaxRequests(
  lines: readonly TaxableLine[],
  shipTo: ShipToAddress | null,
  customerId: string | null,
  isCollection: boolean,
): BuildTaxRequestsResult {
  if (lines.length === 0) return { ok: false, error: 'The invoice has no lines.' }
  if (!lines.some((l) => !l.is_shipping)) {
    return { ok: false, error: 'The invoice has no product lines (only shipping).' }
  }
  if (!isCollection && !shipTo) {
    return { ok: false, error: 'The invoice has no delivery address, so tax cannot be calculated.' }
  }

  const groups: TaxRequestGroup[] = []
  const freightOnly: { depot: USDepot; shipping: number; keys: string[] }[] = []

  for (const depot of US_DEPOTS) {
    const depotLines = lines.filter((l) => l.ship_from_depot === depot)
    if (depotLines.length === 0) continue

    const taxable = depotLines.filter((l) => !l.is_shipping)
    const shippingLines = depotLines.filter((l) => l.is_shipping)
    const shipping = roundCents(shippingLines.reduce((acc, l) => acc + l.line_total, 0))

    // A depot carrying only freight never needs its own dispatch address: its
    // shipping is folded into a group that has goods (freight follows the
    // goods it carries), and TaxJar would reject a request with no line items
    // anyway. The address check therefore applies only to groups with goods.
    if (taxable.length === 0) {
      freightOnly.push({ depot, shipping, keys: shippingLines.map((l) => l.line_key) })
      continue
    }

    const from = DEPOT_FROM_ADDRESSES[depot]
    if (!from) {
      return {
        ok: false,
        error: `The ${depot} dispatch address is not configured yet, so tax cannot be calculated for lines ${
          isCollection ? 'collected from' : 'shipping from'
        } it.`,
      }
    }

    // Collected: origin and destination are the same depot. Delivered: the
    // customer's address, which the guard above proved is present.
    const to = isCollection ? from : (shipTo as ShipToAddress)

    groups.push({
      depot,
      taxableLineKeys: taxable.map((l) => l.line_key),
      shippingLineKeys: shippingLines.map((l) => l.line_key),
      request: {
        from_country: from.country,
        from_state: from.state,
        from_zip: from.zip,
        from_city: from.city,
        from_street: from.street,
        to_country: 'US',
        to_state: to.state,
        to_zip: to.zip,
        to_city: to.city,
        to_street: to.street,
        shipping,
        ...(customerId ? { customer_id: customerId } : {}),
        line_items: taxable.map((l) => ({
          id: l.line_key,
          quantity: l.quantity,
          unit_price: l.unit_price,
          ...(l.discount_percentage > 0
            ? { discount: roundCents(l.quantity * l.unit_price * (l.discount_percentage / 100)) }
            : {}),
        })),
      },
    })
  }

  if (freightOnly.length > 0) {
    const host = groups[0]
    if (!host) return { ok: false, error: 'The invoice has no product lines (only shipping).' }
    for (const group of freightOnly) {
      host.request.shipping = roundCents(host.request.shipping + group.shipping)
      host.shippingLineKeys = [...host.shippingLineKeys, ...group.keys]
    }
  }

  return { ok: true, groups }
}

export interface LineTaxResult {
  line_key: string
  tax_amount: number
  taxable_amount: number | null
  combined_tax_rate: number | null
}

export type ApplyTaxResponsesResult =
  | { ok: true; lines: LineTaxResult[]; taxTotal: number; warnings: string[] }
  | { ok: false; error: string }

/**
 * Map TaxJar responses back onto lines. Per-line values are canonical (they
 * are what Xero sums); a reconciliation gap of more than a cent against
 * TaxJar's own amount_to_collect is surfaced as a warning, never silently
 * absorbed. Shipping tax is allocated across the group's shipping lines
 * proportionally by line_total, cent remainder to the largest.
 */
export function applyTaxResponses(
  lines: readonly TaxableLine[],
  results: readonly { group: TaxRequestGroup; response: TaxJarTaxResponse }[],
): ApplyTaxResponsesResult {
  const warnings: string[] = []
  const byKey = new Map<string, LineTaxResult>()
  let expectedTotal = 0

  for (const { group, response } of results) {
    const tax = response.tax
    if (!tax || typeof tax !== 'object') {
      return { ok: false, error: `TaxJar returned an unexpected response shape for the ${group.depot} group.` }
    }
    expectedTotal += tax.amount_to_collect ?? 0

    if (tax.has_nexus === false) {
      // Registered but not switched on in TaxJar is the dangerous shape: real
      // tax is due and TaxJar returns zero with no error. Maryland is exactly
      // that today, and US-BAL sits in Jessup MD, so every order collected
      // from Baltimore is a Maryland sale. Refuse rather than warn.
      const destination = group.request.to_state
      if (US_REGISTERED_STATES.includes(destination)) {
        return {
          ok: false,
          error: `Echo Barrier is registered for sales tax in ${destination}, but TaxJar reports no nexus there, so it returned zero tax for the ${group.depot} lines. This invoice would under-collect. Switch ${destination} on in the TaxJar account, then recalculate.`,
        }
      }
      warnings.push(
        `TaxJar reports no nexus in ${destination} for the ${group.depot} group, so no tax was collected on those lines. That is expected where Echo Barrier is not registered.`,
      )
    }

    const breakdownItems = tax.breakdown?.line_items ?? []
    const breakdownById = new Map(breakdownItems.map((b) => [String(b.id), b]))

    for (const key of group.taxableLineKeys) {
      const b = breakdownById.get(key)
      if (!b) {
        // Breakdown is legitimately absent when there is no nexus or nothing
        // is taxable; a PARTIAL breakdown missing one of our lines is not.
        if (breakdownItems.length > 0) {
          return { ok: false, error: `TaxJar's breakdown is missing line ${key} for the ${group.depot} group.` }
        }
        byKey.set(key, { line_key: key, tax_amount: 0, taxable_amount: null, combined_tax_rate: null })
        continue
      }
      byKey.set(key, {
        line_key: key,
        tax_amount: roundCents(b.tax_collectable ?? 0),
        taxable_amount: b.taxable_amount ?? null,
        combined_tax_rate: b.combined_tax_rate ?? null,
      })
    }

    // Freight tax for this group, spread across its shipping lines.
    const shippingTax = roundCents(tax.breakdown?.shipping?.tax_collectable ?? 0)
    const shippingLines = group.shippingLineKeys
      .map((key) => lines.find((l) => l.line_key === key))
      .filter((l): l is TaxableLine => Boolean(l))
    if (shippingLines.length > 0) {
      const totalBase = shippingLines.reduce((acc, l) => acc + l.line_total, 0)
      let allocated = 0
      let largest: { key: string; base: number } | null = null
      shippingLines.forEach((l) => {
        const share =
          totalBase > 0 ? roundCents((shippingTax * l.line_total) / totalBase) : shippingLines.length === 1 ? shippingTax : 0
        allocated = roundCents(allocated + share)
        byKey.set(l.line_key, { line_key: l.line_key, tax_amount: share, taxable_amount: null, combined_tax_rate: null })
        if (!largest || l.line_total > largest.base) largest = { key: l.line_key, base: l.line_total }
      })
      const remainder = roundCents(shippingTax - allocated)
      if (remainder !== 0 && largest !== null) {
        const target = byKey.get((largest as { key: string }).key)
        if (target) target.tax_amount = roundCents(target.tax_amount + remainder)
      }
    } else if (shippingTax !== 0) {
      warnings.push(`TaxJar returned freight tax for the ${group.depot} group but the group has no shipping lines.`)
    }
  }

  const out = lines
    .filter((l) => byKey.has(l.line_key))
    .map((l) => byKey.get(l.line_key) as LineTaxResult)
  const taxTotal = roundCents(out.reduce((acc, l) => acc + l.tax_amount, 0))
  const gap = roundCents(taxTotal - roundCents(expectedTotal))
  if (Math.abs(gap) > 0.01) {
    warnings.push(
      `Per-line tax sums to ${taxTotal.toFixed(2)} but TaxJar's order totals sum to ${roundCents(expectedTotal).toFixed(2)} (difference ${gap.toFixed(2)}). Per-line values are used; review before sending.`,
    )
  }

  return { ok: true, lines: out, taxTotal, warnings }
}

/**
 * A collected order that still carries freight is usually a data error, but it
 * is not an error we should block on: Xero is billing that freight either way,
 * so dropping it from the tax base would under-collect on a charge the
 * customer is still paying. Warn, and let the reviewer decide.
 */
export function collectionWarnings(lines: readonly TaxableLine[], isCollection: boolean): string[] {
  if (!isCollection) return []
  const freight = roundCents(lines.filter((l) => l.is_shipping).reduce((acc, l) => acc + l.line_total, 0))
  if (freight <= 0) return []
  return [
    `This invoice is marked collected but still carries freight lines totalling ${freight.toFixed(2)}. Tax on that freight is being calculated at the collection depot.`,
  ]
}

export interface FilingLine extends TaxableLine {
  sku: string | null
  name: string
  description: string | null
  tax_amount: number | null
}

export interface TaxJarFilingOrder {
  transaction_id: string
  transaction_date: string
  from_country: string
  from_state: string
  from_zip: string
  from_city?: string
  from_street?: string
  to_country: string
  to_state: string
  to_zip: string
  to_city?: string
  to_street?: string
  amount: number
  shipping: number
  sales_tax: number
  customer_id?: string
  line_items: {
    id: string
    quantity: number
    product_identifier?: string
    description: string
    unit_price: number
    discount?: number
    sales_tax: number
  }[]
}

/**
 * The only two fields the grouping rule reads.
 *
 * Deliberately narrower than FilingLine: the filing path and the printed
 * document carry different columns, and constraining this to what the rule
 * actually touches lets both use it without either growing fields it has no
 * use for.
 */
export interface ShipmentGroupable {
  is_shipping: boolean
  ship_from_depot: USDepot
}

/** One shipment: the goods leaving a depot, plus the freight attributed to it. */
export interface DepotShipment<L extends ShipmentGroupable> {
  depot: USDepot
  goodsLines: L[]
  shippingLines: L[]
}

/**
 * Split an invoice into one shipment per ship-from depot.
 *
 * Shared deliberately. buildFilingOrders uses it to decide what to FILE, and
 * the printed invoice uses it to decide what to SHOW, including the TaxJar
 * transaction id printed against each shipment. Two copies of this rule would
 * eventually disagree, and the way it would surface is a customer holding a
 * document whose stated transaction id matches nothing that was ever filed.
 *
 * Only depots carrying GOODS become shipments. Freight is attributed exactly as
 * buildTaxRequests attributes it: a depot carrying only freight has that
 * freight folded into the first depot that carries goods, because filing it any
 * other way puts the freight tax in a jurisdiction the calculation never used.
 */
export function depotShipments<L extends ShipmentGroupable>(lines: readonly L[]): DepotShipment<L>[] {
  const depotsWithGoods = US_DEPOTS.filter((d) => lines.some((l) => l.ship_from_depot === d && !l.is_shipping))
  if (depotsWithGoods.length === 0) return []
  const host = depotsWithGoods[0]

  return depotsWithGoods.map((depot) => ({
    depot,
    goodsLines: lines.filter((l) => l.ship_from_depot === depot && !l.is_shipping),
    shippingLines: lines.filter(
      (l) =>
        l.is_shipping &&
        (l.ship_from_depot === depot || (depot === host && !depotsWithGoods.includes(l.ship_from_depot))),
    ),
  }))
}

/**
 * The TaxJar transaction id for one shipment.
 *
 * A single-shipment invoice files under the invoice number alone; a split one
 * suffixes the depot, so the two filings are distinguishable in TaxJar's
 * ledger. Printed on the document next to each shipment.
 */
export function filingTransactionId(invoiceNumber: string, depot: USDepot, shipmentCount: number): string {
  return shipmentCount > 1 ? `${invoiceNumber}-${depot}` : invoiceNumber
}

export type BuildFilingOrdersResult =
  | { ok: true; orders: TaxJarFilingOrder[] }
  | { ok: false; error: string }

/**
 * The filing side of the same mapping: one TaxJar order per ship-from depot,
 * built from the tax that was actually calculated.
 *
 * The invariant this exists to protect is that
 *   buildTaxRequests(...).groups[i].request.to_*
 * equals
 *   buildFilingOrders(...).orders[i].to_*
 * for the same depot. Calculating in one jurisdiction and filing in another
 * is silent, is only visible at return time, and is exactly what a per-invoice
 * (rather than per-depot) destination used to cause. tests/unit/taxjar-filing
 * asserts the equality directly.
 */
export function buildFilingOrders(
  lines: readonly FilingLine[],
  shipTo: ShipToAddress | null,
  customerId: string | null,
  isCollection: boolean,
  opts: { transactionDate: string; xeroInvoiceNumber: string },
): BuildFilingOrdersResult {
  if (!isCollection && !shipTo) {
    return { ok: false, error: 'The invoice has no delivery address, so it cannot be filed to TaxJar.' }
  }

  const shipments = depotShipments(lines)
  if (shipments.length === 0) return { ok: false, error: 'invoice has no product lines' }
  const depotsWithGoods = shipments.map((s) => s.depot)
  const shippingFor = (depot: USDepot) =>
    shipments.find((s) => s.depot === depot)?.shippingLines ?? []

  const orders: TaxJarFilingOrder[] = []

  for (const depot of depotsWithGoods) {
    const from = DEPOT_FROM_ADDRESSES[depot]
    if (!from) return { ok: false, error: `${depot} dispatch address not configured` }

    // Per depot, not per invoice: a collected two-depot invoice has two
    // genuinely different destinations.
    const to = isCollection ? from : { ...(shipTo as ShipToAddress), country: 'US' }

    const taxable = lines.filter((l) => l.ship_from_depot === depot && !l.is_shipping)
    const shippingLines = shippingFor(depot)
    const shipping = roundCents(shippingLines.reduce((acc, l) => acc + l.line_total, 0))
    const salesTax = roundCents(
      [...taxable, ...shippingLines].reduce((acc, l) => acc + Number(l.tax_amount ?? 0), 0),
    )

    // TaxJar sums each line as quantity x unit_price - discount and rejects the
    // order unless `amount` equals that sum plus shipping, EXCLUDING tax.
    // Deriving the discount from the stored line_total makes their arithmetic
    // land on exactly our line totals, so the filed amount and the invoiced
    // amount cannot drift apart by a rounding cent.
    const orderLines = taxable.map((l) => {
      const gross = roundCents(l.quantity * l.unit_price)
      const discount = roundCents(gross - l.line_total)
      return {
        id: l.line_key,
        quantity: l.quantity,
        ...(l.sku ? { product_identifier: l.sku } : {}),
        description: (l.description || l.name).slice(0, 255),
        unit_price: l.unit_price,
        ...(discount > 0 ? { discount } : {}),
        sales_tax: Number(l.tax_amount ?? 0),
      }
    })

    orders.push({
      transaction_id: filingTransactionId(opts.xeroInvoiceNumber, depot, depotsWithGoods.length),
      transaction_date: opts.transactionDate,
      from_country: from.country,
      from_state: from.state,
      from_zip: from.zip,
      from_city: from.city,
      from_street: from.street,
      to_country: to.country,
      to_state: to.state,
      to_zip: to.zip,
      to_city: to.city,
      to_street: to.street,
      amount: roundCents(taxable.reduce((acc, l) => acc + l.line_total, 0) + shipping),
      shipping,
      sales_tax: salesTax,
      ...(customerId ? { customer_id: customerId } : {}),
      line_items: orderLines,
    })
  }

  return { ok: true, orders }
}
