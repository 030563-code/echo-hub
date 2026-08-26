/**
 * Configuration for the US customer-invoicing flow (accepted quotes → TaxJar →
 * Xero). Pure data, safe on both client and server.
 */

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
   * The kit's unit price rides on exactly one component (the hook) so revenue
   * is preserved through the split; the other components default to 0.00.
   * All prices stay editable in the invoice editor.
   */
  carriesKitPrice: boolean
}

export const FITTING_KIT_COMPONENTS: readonly FittingKitComponent[] = [
  { sku: 'HKNA', name: 'Echo Barrier Hooks', qtyPerKit: 1, carriesKitPrice: true },
  { sku: 'BUNNA', name: 'Echo Barrier Bungees', qtyPerKit: 2, carriesKitPrice: false },
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

/** Fitting kits (and their split components) always dispatch from Baltimore,
 *  regardless of where the barriers ship from. */
export const KIT_SHIP_FROM: USDepot = 'US-BAL'

export interface DepotFromAddress {
  street: string
  city: string
  state: string
  zip: string
  country: 'US'
}

/**
 * Dispatch (ship-from) addresses per depot, used as TaxJar's from_ fields.
 * Structured mirror of po_delivery_addresses (whose address column is free
 * text). US-SBD is not yet confirmed (the table itself holds a placeholder);
 * tax calculation refuses San Bernardino groups until it is filled in.
 */
export const DEPOT_FROM_ADDRESSES: Record<USDepot, DepotFromAddress | null> = {
  'US-BAL': {
    street: 'Capitol Warehouse, 8125 Stayton Drive',
    city: 'Jessup',
    state: 'MD',
    zip: '20794',
    country: 'US',
  },
  'US-SBD': null,
}

/** Queue cutoff: accepted deals whose registry row last moved before this date
 *  predate the invoicing flow and stay out of the admin queue. */
export const INVOICING_QUEUE_SINCE = '2026-08-26'

/** The USA SALES "Quotation Accepted" stage id, as n8n writes it into
 *  deals_registry.deal_status. */
export const US_ACCEPTED_DEAL_STATUS = '1170409275'

export const CUSTOMER_INVOICE_STATUSES = [
  'draft',
  'tax_calculated',
  'authorizing',
  'authorized',
  'sent',
  'completed',
  'voided',
] as const
export type CustomerInvoiceStatus = (typeof CUSTOMER_INVOICE_STATUSES)[number]
