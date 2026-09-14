// The commercial-invoice legs, in ONE place.
//
// A leg is one intercompany sale a container travels through: s.r.o. sells to
// Group, then Group sells on to the company that owns the destination depot.
// Every screen, action and type that names a leg reads it from here, so a new
// leg cannot be added in one place and missed in another.
//
// Pure (no 'server-only'): the invoices screens import the labels too.

export const INVOICE_LEGS = ['SRO_TO_GROUP', 'GROUP_TO_USA', 'GROUP_TO_CANADA'] as const

export type InvoiceLeg = (typeof INVOICE_LEGS)[number]

/** The fx_weekly pairs an onward leg converts its EUR base with. */
export type FxPair = 'EUR_USD' | 'EUR_CAD'

export interface LegConfig {
  /** entities.code of the company selling. */
  seller: string
  /** entities.code of the company buying. */
  buyer: string
  /** The currency the invoice is issued in. */
  currency: 'EUR' | 'USD' | 'CAD'
  /** True when the EUR base is converted at an fx_weekly rate. */
  usesFx: boolean
  /** The fx_weekly pair, when usesFx. */
  fxPair: FxPair | null
  /** Plain name for people, e.g. "Group to USA". */
  label: string
}

export const LEG_CONFIG: Record<InvoiceLeg, LegConfig> = {
  SRO_TO_GROUP: { seller: 'EB-SRO', buyer: 'EB-GROUP', currency: 'EUR', usesFx: false, fxPair: null, label: 'SRO to Group' },
  GROUP_TO_USA: { seller: 'EB-GROUP', buyer: 'EB-USA', currency: 'USD', usesFx: true, fxPair: 'EUR_USD', label: 'Group to USA' },
  GROUP_TO_CANADA: { seller: 'EB-GROUP', buyer: 'EB-CANADA', currency: 'CAD', usesFx: true, fxPair: 'EUR_CAD', label: 'Group to Canada' },
}

export function isInvoiceLeg(value: unknown): value is InvoiceLeg {
  return typeof value === 'string' && (INVOICE_LEGS as readonly string[]).includes(value)
}

/** The people-facing name of a leg. An unknown value passes through unchanged. */
export function legLabel(leg: string): string {
  return isInvoiceLeg(leg) ? LEG_CONFIG[leg].label : leg
}

const CURRENCY_SYMBOL: Record<string, string> = { EUR: '€', USD: '$', CAD: 'CA$' }

/** The symbol printed before an amount. An unknown currency prints its code and a space. */
export function currencySymbol(currency: string): string {
  return CURRENCY_SYMBOL[currency] ?? `${currency} `
}

/**
 * Which legs a container needs invoices for, from the depot codes on its
 * shipment lines (shipment_contents.depot_destination).
 *
 *  - SRO to Group, always: every container leaves s.r.o. for Group first.
 *  - Group to USA when any line goes to a US depot (a code starting US-).
 *  - Group to Canada when any line goes to CA-HAM.
 *  - Both onward legs when the destination is unknown: no codes at all, or any
 *    line with a blank one, because that line could be bound for either.
 *
 * Returned in INVOICE_LEGS order.
 */
export function legsForDestination(depotCodes: readonly (string | null | undefined)[]): InvoiceLeg[] {
  const codes = depotCodes.map((c) => (c ?? '').trim())
  const unknown = codes.length === 0 || codes.some((c) => c === '')
  const wanted = new Set<InvoiceLeg>(['SRO_TO_GROUP'])
  if (unknown || codes.some((c) => c.startsWith('US-'))) wanted.add('GROUP_TO_USA')
  if (unknown || codes.includes('CA-HAM')) wanted.add('GROUP_TO_CANADA')
  return INVOICE_LEGS.filter((leg) => wanted.has(leg))
}
