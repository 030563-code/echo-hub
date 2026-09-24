/**
 * Configuration for the US customer-invoicing flow (accepted quotes → TaxJar →
 * Xero). Pure data, safe on both client and server.
 */

import { depotsForOrg, type OrgCode } from '@/lib/organisations'

/**
 * HubSpot product ids that mean "Fitting Kit" (the catalogue holds duplicates,
 * none carrying an hs_sku). A kit line on a quote becomes two invoice lines:
 * hooks and bungees (see FITTING_KIT_COMPONENTS).
 */
export const FITTING_KIT_PRODUCT_IDS: ReadonlySet<string> = new Set([
  '57786096', // "Fitting Kit comprising 1 hook and 2 Bungies"
  '138783', // "Fitting Kits"
  '1640211461', // "Fitting Kits" (duplicate)
])

export interface FittingKitComponent {
  sku: string
  name: string
  qtyPerKit: number
  /**
   * Share of the kit line's money this component's WHOLE LINE carries, so the
   * two bungees together take 0.25 (Dean's 12.5% each, 2026-09-04).
   */
  shareOfKit: number
  /**
   * Exactly one component absorbs the rounding remainder, so hook + 2 bungees
   * is exactly the kit price to the cent. Splitting evenly on both sides would
   * drift on any price that does not divide by eight, and the deal amount would
   * stop reconciling with its own lines. All prices stay editable in the
   * invoice editor.
   */
  takesRemainder: boolean
}

/**
 * Must stay in step with public.split_fitting_kit_lines() in Supabase
 * (migration 20260904110000), which now applies this same split the moment a
 * kit reaches deals_registry. This copy still runs for rows written before that
 * migration, so the two have to agree on both the components and the shares.
 */
export const FITTING_KIT_COMPONENTS: readonly FittingKitComponent[] = [
  { sku: 'HKNA', name: 'Echo Barrier Hooks', qtyPerKit: 1, shareOfKit: 0.75, takesRemainder: true },
  { sku: 'BUNNA', name: 'Echo Barrier Bungees', qtyPerKit: 2, shareOfKit: 0.25, takesRemainder: false },
]

/** Quote lines with these SKUs are freight: they map to TaxJar's `shipping`
 *  field (freight taxability is decided by TaxJar per state), never to a
 *  taxable line item. */
export const SHIPPING_SKUS: ReadonlySet<string> = new Set(['LTLNA'])

export const US_DEPOTS = ['US-BAL', 'US-SBD'] as const
export type USDepot = (typeof US_DEPOTS)[number]

export function isUSDepot(value: unknown): value is USDepot {
  return value === 'US-BAL' || value === 'US-SBD'
}

export const CA_DEPOTS = ['CA-HAM'] as const
export type CADepot = (typeof CA_DEPOTS)[number]

export function isCADepot(value: unknown): value is CADepot {
  return value === 'CA-HAM'
}

/** France. One depot, and it is the organisation's only one. Dean, 22 Sep
 *  2026: Claire's invoicing moves into the Hub on the USA ladder, with a Xero
 *  DRAFT standing where TaxJar stands. See invoicing-profile.ts. */
export const FR_DEPOTS = ['EU-FR'] as const
export type FRDepot = (typeof FR_DEPOTS)[number]

export function isFRDepot(value: unknown): value is FRDepot {
  return value === 'EU-FR'
}

/**
 * Every depot the invoicing module can raise an invoice from.
 *
 * 🔴 `USDepot` IS DELIBERATELY NOT WIDENED. Two kinds of code use a depot here
 * and they are not interchangeable:
 *
 *   - Shared machinery (the draft builder, the editor's ship-from picker, the
 *     printed document, the line schema) works for any organisation and takes
 *     `InvoiceDepot`.
 *   - The TaxJar paths (`tax-mapping.ts`, the Tax Setup page, the filing
 *     transaction id) are US-only by nature, because TaxJar is the US sales-tax
 *     engine and Canada does not go near it. Those keep `USDepot`, so the type
 *     checker refuses a Canadian depot at the door rather than letting one
 *     reach a nexus lookup that would answer for the wrong country.
 *
 * Widening `USDepot` itself would have been one character of work and would
 * have removed exactly the guard that makes this safe.
 */
export const INVOICE_DEPOTS = [...US_DEPOTS, ...CA_DEPOTS, ...FR_DEPOTS] as const
export type InvoiceDepot = (typeof INVOICE_DEPOTS)[number]

export function isInvoiceDepot(value: unknown): value is InvoiceDepot {
  return isUSDepot(value) || isCADepot(value) || isFRDepot(value)
}

/**
 * The depots an organisation invoices from.
 *
 * Read from the organisation registry (depotsForOrg) rather than restated here,
 * so the invoicing module and every other module can never disagree about which
 * company a depot belongs to. Only depots this module can raise an invoice from
 * survive the filter.
 */
export function invoiceDepotsForOrg(org: OrgCode): readonly InvoiceDepot[] {
  return depotsForOrg(org).filter(isInvoiceDepot)
}

/** A US deal's fitting kits dispatch from Baltimore, whichever US depot the
 *  barriers leave from. */
export const KIT_SHIP_FROM: USDepot = 'US-BAL'

/**
 * Where a deal's fitting-kit hooks and bungees dispatch from.
 *
 * Mirrors public.split_fitting_kit_lines() in Supabase, which already decides
 * this on the way into deals_registry: Baltimore for a US deal, the deal's own
 * depot for anyone else. Hamilton stocks hooks and bungees under its own Xero
 * items, so pinning a Canadian kit to Baltimore put a US depot on a Canadian
 * invoice, and the draft save then refused that invoice outright.
 */
export function kitShipFrom(dealDepot: InvoiceDepot): InvoiceDepot {
  return isUSDepot(dealDepot) ? KIT_SHIP_FROM : dealDepot
}

export interface DepotFromAddress {
  street: string
  city: string
  /** US state code, or Canadian province code. Null for a country that has no
   *  such thing on an address, which is France. */
  state: string | null
  /** US zip, Canadian postal code, or French code postal. */
  zip: string
  country: 'US' | 'CA' | 'FR'
}

/**
 * Dispatch (ship-from) addresses per depot, used as TaxJar's from_ fields, and
 * as BOTH from_ and to_ on a collected order.
 *
 * Source: "Where this build stands" (EBUSA order-to-invoice handover, 2026-09-02).
 * Each zip was verified against TaxJar GET /v2/rates/{zip}: 20794 resolves to
 * MD (6%), 91730 to Rancho Cucamonga, San Bernardino county, CA (7.75%).
 */
export const DEPOT_FROM_ADDRESSES: Record<InvoiceDepot, DepotFromAddress | null> = {
  'US-BAL': {
    street: 'Capitol Warehouse, 8125 Stayton Drive',
    city: 'Jessup',
    state: 'MD',
    zip: '20794',
    country: 'US',
  },
  'US-SBD': {
    street: '9119 Milliken Ave',
    city: 'Rancho Cucamonga',
    state: 'CA',
    zip: '91730',
    country: 'US',
  },
  /**
   * 🔴 NULL UNTIL DEAN SUPPLIES THE HAMILTON ADDRESS. Deliberately not guessed.
   *
   * null is a supported value here, not a gap: the editor already lists depots
   * with no dispatch address and warns about them, and the printed document
   * falls back rather than inventing a place. A plausible-looking invented
   * address would print on a customer's invoice and be believed, which is the
   * worse failure. Canada does not use these as TaxJar from_ fields (it never
   * calls TaxJar); this feeds the "Despatched from" line on the PDF.
   */
  'CA-HAM': null,
  /**
   * 🔴 NULL UNTIL DEAN SUPPLIES THE FRENCH DEPOT ADDRESS. Same rule as Hamilton:
   * a guessed dispatch address would print on a customer's invoice and be
   * believed. France never calls TaxJar, so this only feeds the "Despatched
   * from" line and the collection address on the document. Note this is the
   * DEPOT, not the registered office at 25 place de la Madeleine, which is the
   * seller block's business (seller.ts).
   */
  'EU-FR': null,
}

/**
 * A US depot's dispatch address with the state TaxJar needs, or null when the
 * depot has no address configured. Exists so the TaxJar paths, which are
 * US-only by construction, never see the `string | null` state the wider
 * DepotFromAddress carries for France.
 */
export function usDepotAddress(depot: USDepot): (DepotFromAddress & { state: string }) | null {
  const from = DEPOT_FROM_ADDRESSES[depot]
  if (!from || from.state === null) return null
  return { ...from, state: from.state }
}

/**
 * States where Echo Barrier USA holds a sales-tax registration.
 *
 * This is NOT the same as where TaxJar will collect. TaxJar returns
 * has_nexus:false and zero tax for any state not in its nexus settings, with
 * no error, so a state we are registered in but have not switched on in TaxJar
 * silently under-collects real tax. Maryland is exactly that case today: the
 * licence (CRN 37198084) is held back pending the Comptroller confirming the
 * FEIN on the Combined Registration Application.
 *
 * calculateInvoiceTax hard-blocks when a destination falls in this list but
 * TaxJar reports no nexus. The block clears by itself the moment the state is
 * switched on in TaxJar, because the live nexus list is what it compares to.
 *
 * Florida and New Jersey are deliberately absent: no registration is held, so
 * zero tax there is the correct answer rather than a silent failure.
 */
export const US_REGISTERED_STATES: readonly string[] = [
  'CA', // live
  'IL', // live
  'MA', // live
  'MN', // live
  'SC', // live
  'TN', // live
  'VA', // live, files monthly by locality (ST-1A)
  'MD', // REGISTERED BUT HELD in TaxJar, see above
]

/** Queue cutoff: accepted deals whose registry row last moved before this date
 *  predate the invoicing flow and stay out of the admin queue. */
export const INVOICING_QUEUE_SINCE = '2026-08-26'

/** The USA SALES "Quotation Accepted" stage id, as n8n writes it into
 *  deals_registry.deal_status. */
export const US_ACCEPTED_DEAL_STATUS = '1170409275'

export const CUSTOMER_INVOICE_STATUSES = [
  'draft',
  'tax_calculated',
  /** TaxJar order transaction created, and the EBUS number allocated with it.
   *  Filing is keyed on the number, and it is the first step that commits
   *  anything outward, so it is where the number stops being a holding
   *  reference (Dean, 2026-09-03). */
  'filed',
  /** The invoice PDF has been generated and stored. */
  'documented',
  /** The PDF has been emailed to the customer. */
  'sent',
  /** The Xero call is in flight. */
  'authorizing',
  /** In Xero, with the PDF attached. The end of the line. */
  'completed',
  /** Legacy, no longer written. Both belonged to the old order, where Xero came
   *  second and the number was allocated there. Kept so historical rows and the
   *  rollback stay valid. */
  'raised',
  'authorized',
  'voided',
] as const
export type CustomerInvoiceStatus = (typeof CUSTOMER_INVOICE_STATUSES)[number]

/**
 * The pipeline as a rep sees it, in Dean's words (2026-09-03).
 *
 * One stage per tab, and an invoice appears under exactly one of them. Moving
 * it on is what takes it out of the previous queue, so the tabs are a worklist
 * rather than a filter: whatever is sitting in a tab is waiting for that step.
 *
 * `draft` is deliberately absent. An invoice opened from an accepted quote but
 * not yet taxed still belongs under Accepted Quotes, which is where the rep
 * went to open it.
 */
export const INVOICE_STAGES = [
  { status: 'tax_calculated', label: 'Tax calculated', href: '/invoicing/tax-calculated' },
  { status: 'filed', label: 'TaxJar order transaction created', href: '/invoicing/filed' },
  { status: 'documented', label: 'Invoice draft generated', href: '/invoicing/documented' },
  { status: 'sent', label: 'Invoice sent', href: '/invoicing/sent' },
  { status: 'completed', label: 'Invoice sent to Xero and attached PDF', href: '/invoicing/completed' },
] as const satisfies readonly { status: CustomerInvoiceStatus; label: string; href: string }[]

export type InvoiceStage = (typeof INVOICE_STAGES)[number]

/** The stage an invoice is waiting in, or null when it is not in the pipeline
 *  (a bare draft, a void, or one of the two legacy statuses). */
export function stageForStatus(status: CustomerInvoiceStatus): InvoiceStage | null {
  return INVOICE_STAGES.find((s) => s.status === status) ?? null
}
