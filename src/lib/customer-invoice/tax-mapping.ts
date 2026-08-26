/**
 * Pure request/response mapping between draft-invoice lines and TaxJar's
 * /v2/taxes endpoint. TaxJar accepts a single from_ address per call, so lines
 * are grouped by ship-from depot and one request is built per group; each
 * group carries its own shipping total. No IO here — the server action in
 * src/app/actions/invoicing/calculate-tax.ts owns the HTTP and persistence.
 */

import { roundCents } from '@/lib/quote-math'
import { DEPOT_FROM_ADDRESSES, US_DEPOTS, type USDepot } from '@/lib/customer-invoice/constants'

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

export function buildTaxRequests(
  lines: readonly TaxableLine[],
  shipTo: ShipToAddress,
  customerId: string | null,
): BuildTaxRequestsResult {
  if (lines.length === 0) return { ok: false, error: 'The invoice has no lines.' }
  if (!lines.some((l) => !l.is_shipping)) {
    return { ok: false, error: 'The invoice has no product lines (only shipping).' }
  }

  const groups: TaxRequestGroup[] = []
  for (const depot of US_DEPOTS) {
    const depotLines = lines.filter((l) => l.ship_from_depot === depot)
    if (depotLines.length === 0) continue

    const from = DEPOT_FROM_ADDRESSES[depot]
    if (!from) {
      return {
        ok: false,
        error: `The ${depot} dispatch address is not configured yet, so tax cannot be calculated for lines shipping from it.`,
      }
    }

    const taxable = depotLines.filter((l) => !l.is_shipping)
    const shippingLines = depotLines.filter((l) => l.is_shipping)
    // A depot group holding only shipping lines has no taxable base of its
    // own; fold its freight into the request anyway so TaxJar rules on it.
    const shipping = roundCents(shippingLines.reduce((acc, l) => acc + l.line_total, 0))

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
        to_state: shipTo.state,
        to_zip: shipTo.zip,
        to_city: shipTo.city,
        to_street: shipTo.street,
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
      warnings.push(
        `TaxJar reports no nexus for the ${group.depot} group's calculation — no tax collected for those lines. Check the TaxJar account's state settings if that looks wrong.`,
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
