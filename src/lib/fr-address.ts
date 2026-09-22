/**
 * French delivery-address validation and sanitization, the sibling of
 * us-address.ts. Pure module, safe on both client and server.
 *
 * A French address has no state. It has a five digit code postal, and the
 * first two digits are the département, so "75008" already says Paris. The
 * database CHECK on customer_invoices refuses a delivery_state for a French
 * row, so this module never produces one.
 *
 * 🔴 The old US zip regex accepted French postcodes BY ACCIDENT: 75008 matches
 * `^\d{5}(-\d{4})?$`. This module exists so the match is deliberate, and so a
 * ZIP+4 shape (75008-1234, which is not a thing in France) is refused.
 */

import { cleanAddressField } from '@/lib/us-address'

export interface FRDeliveryAddress {
  street: string
  city: string
  /** Five digits. The database stores it in delivery_zip, the same column the
   *  US zip uses, so the name follows the column rather than the country. */
  zip: string
}

/**
 * The only country a French invoice delivers to today. Monaco is inside French
 * VAT territory and Claire has invoiced there, but the customer_invoices CHECK
 * accepts 'US' and 'FR' only, and widening it is a decision about the VAT case,
 * not a spelling. Open gap, recorded in the vault note.
 */
export const FR_DELIVERY_COUNTRIES: readonly { value: string; label: string }[] = [
  { value: 'FR', label: 'France' },
]

const POSTCODE_RE = /^\d{5}$/

export type SanitizeFRAddressResult =
  | { ok: true; value: FRDeliveryAddress }
  | { ok: false; error: string }

/**
 * Sanitize and validate a French delivery address. Every failure names the
 * offending field, in the same voice as sanitizeUSAddress, because the same
 * editor shows both.
 */
export function sanitizeFRAddress(input: Partial<FRDeliveryAddress> | null | undefined): SanitizeFRAddressResult {
  const street = cleanAddressField(input?.street)
  const city = cleanAddressField(input?.city)
  // "75 008" is how some people write it; the column wants the digits.
  const zip = cleanAddressField(input?.zip).replace(/ /g, '')

  if (!street) return { ok: false, error: 'Delivery street address is required.' }
  if (street.length > 255) return { ok: false, error: 'Delivery street address is too long (255 characters max).' }
  if (!city) return { ok: false, error: 'Delivery city is required.' }
  if (city.length > 100) return { ok: false, error: 'Delivery city is too long (100 characters max).' }
  if (!POSTCODE_RE.test(zip)) return { ok: false, error: 'Delivery postcode must be 5 digits (e.g. 75008).' }

  return { ok: true, value: { street, city, zip } }
}
