/**
 * One door for delivery addresses, whichever country they are in.
 *
 * us-address.ts, fr-address.ts and ca-address.ts each know their own shape. This
 * module lets the invoicing editor, the acceptance gate and the actions ask one
 * question, "is this a valid delivery address for THIS country", without each of
 * them growing a switch. Pure, safe on both client and server.
 *
 * The per-country answers are records keyed by country rather than ternaries,
 * so adding a country is a compile error in every place that has to decide
 * something about it. A ternary quietly handed the new country the last branch.
 */

import { sanitizeUSAddress, DELIVERY_COUNTRIES, US_STATES } from '@/lib/us-address'
import { sanitizeFRAddress, FR_DELIVERY_COUNTRIES } from '@/lib/fr-address'
import { sanitizeCAAddress, normalizeCAPostalCode, CA_DELIVERY_COUNTRIES, CA_PROVINCES } from '@/lib/ca-address'
import type { InvoiceCountry } from '@/lib/customer-invoice/invoicing-profile'

export interface DeliveryAddressInput {
  street?: string | null
  city?: string | null
  /** A US state or a Canadian province. Ignored for a country that has neither. */
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
    case 'CA': {
      // The columns are called state and zip because the USA came first; a
      // Canadian address keeps its province and postal code in them.
      const r = sanitizeCAAddress({
        street: input?.street ?? '',
        city: input?.city ?? '',
        province: input?.state ?? '',
        postalCode: input?.zip ?? '',
      })
      return r.ok
        ? { ok: true, value: { street: r.value.street, city: r.value.city, state: r.value.province, zip: r.value.postalCode } }
        : r
    }
  }
}

const COUNTRIES: Record<InvoiceCountry, readonly { value: string; label: string }[]> = {
  US: DELIVERY_COUNTRIES,
  FR: FR_DELIVERY_COUNTRIES,
  CA: CA_DELIVERY_COUNTRIES,
}

/** The countries the picker offers for this organisation's invoices. */
export function deliveryCountriesFor(country: InvoiceCountry): readonly { value: string; label: string }[] {
  return COUNTRIES[country]
}

const STATE_OPTIONS: Record<InvoiceCountry, readonly { code: string; name: string }[]> = {
  US: US_STATES,
  CA: CA_PROVINCES,
  // A French address has no state, and the database refuses one on a French row.
  FR: [],
}

/** Whether an address in this country carries a state or province field. */
export function hasStateField(country: InvoiceCountry): boolean {
  return STATE_OPTIONS[country].length > 0
}

/** The states or provinces a picker offers, in name order. Empty for France. */
export function stateOptionsFor(country: InvoiceCountry): readonly { code: string; name: string }[] {
  return STATE_OPTIONS[country]
}

const STATE_LABEL: Record<InvoiceCountry, string> = { US: 'State', CA: 'Province', FR: 'State' }

/** What the form calls the state field. */
export function stateLabel(country: InvoiceCountry): string {
  return STATE_LABEL[country]
}

const POSTCODE_LABEL: Record<InvoiceCountry, string> = { US: 'Zip', FR: 'Postcode', CA: 'Postal code' }

/** What the form calls the postal code field. */
export function postcodeLabel(country: InvoiceCountry): string {
  return POSTCODE_LABEL[country]
}

// The Canadian example is Canada Post's own notation for the format, not an
// address.
const POSTCODE_EXAMPLE: Record<InvoiceCountry, string> = { US: '20794', FR: '75008', CA: 'A1A 1A1' }

/** An example the placeholder can show. */
export function postcodeExample(country: InvoiceCountry): string {
  return POSTCODE_EXAMPLE[country]
}

/**
 * What is wrong with a postal code as typed, for the line under the field, or
 * null when it is fine or still empty. The server sanitizer is the rule; this
 * only says so while the rep is still typing.
 */
export function postcodeProblem(country: InvoiceCountry, typed: string): string | null {
  const value = typed.trim()
  if (value === '') return null
  switch (country) {
    case 'US':
      return /^\d{5}(-\d{4})?$/.test(value) ? null : 'Zip must be 5 digits (or ZIP+4, e.g. 20794-1234).'
    case 'FR':
      return /^\d{5}$/.test(value) ? null : 'Postcode must be 5 digits (e.g. 75008).'
    case 'CA':
      return normalizeCAPostalCode(value) ? null : 'Postal code must be in the form A1A 1A1.'
  }
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
