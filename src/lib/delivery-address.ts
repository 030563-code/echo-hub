/**
 * One door for delivery addresses, whichever country they are in.
 *
 * us-address.ts and fr-address.ts each know their own shape. This module lets
 * the invoicing editor, the acceptance gate and the actions ask one question,
 * "is this a valid delivery address for THIS country", without each of them
 * growing a switch. Pure, safe on both client and server.
 */

import { sanitizeUSAddress, DELIVERY_COUNTRIES } from '@/lib/us-address'
import { sanitizeFRAddress, FR_DELIVERY_COUNTRIES } from '@/lib/fr-address'
import type { InvoiceCountry } from '@/lib/customer-invoice/invoicing-profile'

export interface DeliveryAddressInput {
  street?: string | null
  city?: string | null
  /** Ignored for a country that has no state field. */
  state?: string | null
  zip?: string | null
}

export interface DeliveryAddress {
  street: string
  city: string
  /** Null for a country whose addresses carry no state or province. */
  state: string | null
  zip: string
}

export type SanitizeDeliveryAddressResult = { ok: true; value: DeliveryAddress } | { ok: false; error: string }

/** Validate and sanitize a delivery address under the given country's rules. */
export function sanitizeDeliveryAddress(
  country: InvoiceCountry,
  input: DeliveryAddressInput | null | undefined,
): SanitizeDeliveryAddressResult {
  switch (country) {
    case 'US': {
      const r = sanitizeUSAddress({
        street: input?.street ?? '',
        city: input?.city ?? '',
        state: input?.state ?? '',
        zip: input?.zip ?? '',
      })
      return r.ok ? { ok: true, value: { ...r.value } } : r
    }
    case 'FR': {
      const r = sanitizeFRAddress({ street: input?.street ?? '', city: input?.city ?? '', zip: input?.zip ?? '' })
      return r.ok ? { ok: true, value: { ...r.value, state: null } } : r
    }
  }
}

/** The countries the picker offers for this organisation's invoices. */
export function deliveryCountriesFor(country: InvoiceCountry): readonly { value: string; label: string }[] {
  return country === 'US' ? DELIVERY_COUNTRIES : FR_DELIVERY_COUNTRIES
}

/** Whether an address in this country carries a state or province field. */
export function hasStateField(country: InvoiceCountry): boolean {
  return country === 'US'
}

/** What the form calls the postal code field. */
export function postcodeLabel(country: InvoiceCountry): string {
  return country === 'US' ? 'Zip' : 'Postcode'
}

/** An example the placeholder can show. */
export function postcodeExample(country: InvoiceCountry): string {
  return country === 'US' ? '20794' : '75008'
}

export interface AcceptanceFields {
  /** HubSpot win_probability option value, '' when unset. */
  winProbability: string
  /** Will Call: the customer collects from the sending depot. */
  isCollection: boolean
  hasAssociatedCompany: boolean
  delivery: DeliveryAddressInput
}

/**
 * Whether the Change Stage dialog may submit an acceptance into an organisation
 * that invoices through the Hub.
 *
 * The country-aware form of usAcceptanceComplete, and the same three rules: a
 * company to invoice, a probability of close (the backbone), and, for a
 * delivered order, a full address in THIS country's shape, checked with the
 * same sanitizer updateDealStage runs so the dialog can never enable a submit
 * the server is about to refuse. A collected order needs no address.
 */
export function acceptanceComplete(country: InvoiceCountry, fields: AcceptanceFields): boolean {
  if (!fields.hasAssociatedCompany) return false
  if (fields.winProbability === '') return false
  if (fields.isCollection) return true
  return sanitizeDeliveryAddress(country, fields.delivery).ok
}
