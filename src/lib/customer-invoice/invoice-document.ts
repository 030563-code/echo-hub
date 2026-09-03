/**
 * The invoice row and its lines, shaped into everything the document prints.
 *
 * Pure: no clock, no fetch, no env. Dates, the logo and the remittance block
 * all arrive as arguments, which is what makes the numbers on the page unit
 * testable without rendering a PDF.
 *
 * Shipments come from depotShipments(), the same function buildFilingOrders
 * uses, so the transaction id printed against a shipment is by construction the
 * one it was filed under.
 */

import { depotLabel } from '@/lib/depot-constants'
import { normalizeUSState, DELIVERY_COUNTRIES } from '@/lib/us-address'
import { DEPOT_FROM_ADDRESSES, type USDepot } from './constants'
import { depotShipments, filingTransactionId } from './tax-mapping'
import { summariseTaxResponse, type DepotTaxBreakdown } from './tax-breakdown'
import type { RemittanceDetails } from './seller'

function roundCents(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100
}

function num(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : 0
}

/** The subset of a customer_invoice_lines row the document needs. */
export interface InvoiceDocumentLineRow {
  line_key: string
  name: string
  description: string | null
  quantity: number | string
  unit_price: number | string
  line_total: number | string
  is_shipping: boolean
  ship_from_depot: USDepot
  tax_amount: number | string | null
  combined_tax_rate: number | string | null
  sort_order: number
}

/** The subset of a customer_invoices row the document needs. */
export interface InvoiceDocumentHeaderRow {
  invoice_number: string | null
  holding_reference: string
  invoice_date: string | null
  due_date: string | null
  currency: string
  company_name: string | null
  customer_po_number: string | null
  delivery_city: string | null
  delivery_state: string | null
  delivery_zip: string | null
  delivery_street: string | null
  delivery_country: string | null
  is_collection: boolean
  billing_name: string | null
  billing_line1: string | null
  billing_line2: string | null
  billing_city: string | null
  billing_region: string | null
  billing_postal_code: string | null
  billing_country: string | null
  billing_email: string | null
  subtotal: number | string | null
  shipping_total: number | string | null
  tax_total: number | string | null
  total: number | string | null
  taxjar_response: unknown
}

export interface InvoiceDocumentLine {
  description: string
  detail: string | null
  quantity: number
  unitPrice: number
  net: number
  /** null prints as "exempt": the line carries no tax, which for freight is a
   *  jurisdiction decision rather than a missing value. */
  taxRate: number | null
  tax: number
  lineTotal: number
  isShipping: boolean
}

export interface InvoiceDocumentShipment {
  depot: USDepot
  /** "US-BAL, Jessup MD" — the code a rep recognises plus the place it left. */
  label: string
  /** What this shipment is, or will be, filed under in TaxJar. Absent until the
   *  invoice has a number. */
  taxjarTransactionId: string | null
  lines: InvoiceDocumentLine[]
  net: number
  tax: number
  total: number
}

export interface InvoiceDocument {
  /** The customer-facing number, or the internal holding reference with a flag
   *  when the invoice has not been numbered yet. */
  reference: string
  isDraftReference: boolean
  issuedOn: string | null
  dueOn: string | null
  paymentTerms: string | null
  customerName: string
  customerPoNumber: string | null
  /** The delivery address in full. Empty on a collected order except for the
   *  line saying so. */
  shipTo: string[]
  /** The Xero contact, snapshotted. Empty when it has not been captured yet,
   *  which a preview shows rather than hides. */
  billTo: string[]
  isCollection: boolean
  currency: string
  shipments: InvoiceDocumentShipment[]
  /** True when the order left more than one depot, which changes the table from
   *  a flat list to per-shipment groups. */
  isSplit: boolean
  taxableNet: number
  freight: number
  freightIsTaxed: boolean
  salesTax: number
  jurisdictions: { label: string; rate: number; amount: number }[]
  totalDue: number
  taxDetail: DepotTaxBreakdown[]
  remittance: RemittanceDetails
}

/**
 * The delivery address in full, as lines.
 *
 * The street was previously dropped and only "Los Angeles, CA 90066" printed.
 * A delivery address without a street is not a delivery address, and it is the
 * field the tax was calculated against, so it is the one the customer is most
 * likely to want to check.
 */
/** 'US' is what the column stores and what TaxJar wants; 'USA' is what a
 *  reader expects to see. An unknown code prints as itself rather than
 *  vanishing. */
function countryLabel(code: string | null): string {
  const raw = (code ?? '').trim()
  if (raw === '') return ''
  return DELIVERY_COUNTRIES.find((c) => c.value === raw)?.label ?? raw
}

function shipToLines(header: InvoiceDocumentHeaderRow): string[] {
  if (header.is_collection) return ['Collected by the customer']
  const street = (header.delivery_street ?? '').trim()
  const cityState = [header.delivery_city, normalizeUSState(header.delivery_state)]
    .map((p) => (p ?? '').trim())
    .filter((p) => p !== '')
    .join(', ')
  const last = [cityState, (header.delivery_zip ?? '').trim()].filter((p) => p !== '').join(' ')
  // The country belongs on a shipping address like any other. It is stored as
  // the ISO code the tax API wants and printed as the form a reader expects.
  const country = countryLabel(header.delivery_country)
  return [street, last, country].filter((p) => p !== '')
}

/**
 * The Xero contact as printed lines, skipping whatever Xero does not hold.
 *
 * The AP email is deliberately NOT printed (Dean, 2026-09-03). It is where the
 * invoice gets sent, not something the customer needs read back to them, and it
 * is the one line on the block that is ours rather than theirs.
 */
function billToLines(header: InvoiceDocumentHeaderRow): string[] {
  // Normalised at render as well as at snapshot, so a row captured before the
  // canonicalisation landed still prints "CA" rather than "California".
  const cityRegion = [header.billing_city, normalizeUSState(header.billing_region)]
    .map((p) => (p ?? '').trim())
    .filter((p) => p !== '')
    .join(', ')
  const last = [cityRegion, (header.billing_postal_code ?? '').trim()].filter((p) => p !== '').join(' ')
  return [
    header.billing_name ?? header.company_name,
    header.billing_line1,
    header.billing_line2,
    last,
    header.billing_country,
  ]
    .map((p) => (p ?? '').trim())
    .filter((p) => p !== '')
}

/**
 * The depot as the CUSTOMER should read it: "Jessup MD", not "EX US-BAL".
 *
 * Dean, 2026-09-03. The code is ours, it means nothing to a buyer, and on a
 * document whose whole job is to be understood by someone outside the company
 * it is noise. Falls back to the code only when a depot has no configured
 * address, where a code is still better than a blank.
 */
function depotPlace(depot: USDepot): string {
  const from = DEPOT_FROM_ADDRESSES[depot]
  return from ? `${from.city} ${from.state}` : depotLabel(depot)
}

function toDocumentLine(row: InvoiceDocumentLineRow): InvoiceDocumentLine {
  const quantity = num(row.quantity)
  const unitPrice = num(row.unit_price)
  const net = roundCents(num(row.line_total))
  const tax = roundCents(num(row.tax_amount))
  // A null rate is meaningful and is NOT the same as a zero rate. Freight in a
  // state that exempts separately stated freight comes back with no rate at
  // all, and the document says "exempt" rather than "0.000%".
  const rate = row.combined_tax_rate === null || row.combined_tax_rate === undefined ? null : num(row.combined_tax_rate)
  return {
    description: row.name,
    detail: row.description && row.description.trim() !== '' && row.description !== row.name ? row.description : null,
    quantity,
    unitPrice,
    net,
    taxRate: rate,
    tax,
    lineTotal: roundCents(net + tax),
    isShipping: row.is_shipping,
  }
}

/**
 * Build everything the invoice document prints.
 *
 * `paymentTerms` is passed in rather than derived: the words live in Xero on
 * the contact, and this module does not reach the network.
 */
export function buildInvoiceDocument(
  header: InvoiceDocumentHeaderRow,
  lines: readonly InvoiceDocumentLineRow[],
  opts: { remittance: RemittanceDetails; paymentTerms?: string | null },
): InvoiceDocument {
  const ordered = [...lines].sort((a, b) => a.sort_order - b.sort_order)
  const grouped = depotShipments(ordered)

  const shipments: InvoiceDocumentShipment[] = grouped.map((group) => {
    // Goods first, then the freight attributed to this depot, which is the
    // order a reader expects and the order the mockup shows.
    const rows = [...group.goodsLines, ...group.shippingLines]
    const docLines = rows.map(toDocumentLine)
    const net = roundCents(docLines.reduce((acc, l) => acc + l.net, 0))
    const tax = roundCents(docLines.reduce((acc, l) => acc + l.tax, 0))
    return {
      depot: group.depot,
      label: depotPlace(group.depot),
      taxjarTransactionId: header.invoice_number
        ? filingTransactionId(header.invoice_number, group.depot, grouped.length)
        : null,
      lines: docLines,
      net,
      tax,
      total: roundCents(net + tax),
    }
  })

  const allLines = shipments.flatMap((s) => s.lines)
  const freight = roundCents(allLines.filter((l) => l.isShipping).reduce((acc, l) => acc + l.net, 0))
  const taxableNet = roundCents(allLines.filter((l) => !l.isShipping).reduce((acc, l) => acc + l.net, 0))
  const freightTax = roundCents(allLines.filter((l) => l.isShipping).reduce((acc, l) => acc + l.tax, 0))

  const taxDetail = summariseTaxResponse(header.taxjar_response)

  // Jurisdiction rows are summed ACROSS depots. A split invoice delivering to
  // one address resolves to one jurisdiction, so the levels line up; where they
  // do not, summing by label is still the only honest presentation.
  const byLabel = new Map<string, { label: string; rate: number; amount: number }>()
  for (const group of taxDetail) {
    for (const j of group.jurisdictions) {
      const existing = byLabel.get(j.label)
      if (existing) existing.amount = roundCents(existing.amount + j.amount)
      else byLabel.set(j.label, { ...j })
    }
  }

  const salesTax = roundCents(allLines.reduce((acc, l) => acc + l.tax, 0))

  return {
    reference: header.invoice_number ?? header.holding_reference,
    isDraftReference: header.invoice_number === null,
    issuedOn: header.invoice_date,
    dueOn: header.due_date,
    paymentTerms: opts.paymentTerms ?? null,
    customerName: header.company_name ?? 'Customer',
    customerPoNumber: header.customer_po_number,
    shipTo: shipToLines(header),
    billTo: billToLines(header),
    isCollection: header.is_collection,
    currency: header.currency || 'USD',
    shipments,
    isSplit: shipments.length > 1,
    taxableNet,
    freight,
    freightIsTaxed: freightTax > 0,
    salesTax,
    jurisdictions: [...byLabel.values()],
    totalDue: roundCents(taxableNet + freight + salesTax),
    taxDetail,
    remittance: opts.remittance,
  }
}
