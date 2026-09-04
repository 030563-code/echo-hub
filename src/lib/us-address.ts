/**
 * US delivery-address validation and sanitization for the acceptance gate and
 * the invoicing editor. Pure module, safe on both client and server.
 *
 * This is the only address validation the flow gets: TaxJar's address
 * validation endpoint is unavailable in sandbox, so strict format checks here
 * plus the review step in the invoicing panel are the backstop. TaxJar requires
 * to_state and to_zip for US calculations; street and city improve accuracy.
 */

export interface USDeliveryAddress {
  street: string
  city: string
  state: string
  zip: string
}

export const US_STATE_CODES: readonly string[] = [
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'DC', 'FL', 'GA', 'HI', 'ID',
  'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD', 'MA', 'MI', 'MN', 'MS', 'MO',
  'MT', 'NE', 'NV', 'NH', 'NJ', 'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA',
  'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY',
]

const STATE_NAME_TO_CODE: Record<string, string> = {
  ALABAMA: 'AL', ALASKA: 'AK', ARIZONA: 'AZ', ARKANSAS: 'AR', CALIFORNIA: 'CA',
  COLORADO: 'CO', CONNECTICUT: 'CT', DELAWARE: 'DE',
  'DISTRICT OF COLUMBIA': 'DC', FLORIDA: 'FL', GEORGIA: 'GA', HAWAII: 'HI',
  IDAHO: 'ID', ILLINOIS: 'IL', INDIANA: 'IN', IOWA: 'IA', KANSAS: 'KS',
  KENTUCKY: 'KY', LOUISIANA: 'LA', MAINE: 'ME', MARYLAND: 'MD',
  MASSACHUSETTS: 'MA', MICHIGAN: 'MI', MINNESOTA: 'MN', MISSISSIPPI: 'MS',
  MISSOURI: 'MO', MONTANA: 'MT', NEBRASKA: 'NE', NEVADA: 'NV',
  'NEW HAMPSHIRE': 'NH', 'NEW JERSEY': 'NJ', 'NEW MEXICO': 'NM',
  'NEW YORK': 'NY', 'NORTH CAROLINA': 'NC', 'NORTH DAKOTA': 'ND', OHIO: 'OH',
  OKLAHOMA: 'OK', OREGON: 'OR', PENNSYLVANIA: 'PA', 'RHODE ISLAND': 'RI',
  'SOUTH CAROLINA': 'SC', 'SOUTH DAKOTA': 'SD', TENNESSEE: 'TN', TEXAS: 'TX',
  UTAH: 'UT', VERMONT: 'VT', VIRGINIA: 'VA', WASHINGTON: 'WA',
  'WEST VIRGINIA': 'WV', WISCONSIN: 'WI', WYOMING: 'WY',
}

/**
 * A US state as its 2-letter code, whatever form it arrived in.
 *
 * Xero stores whatever was typed into it, so a contact can legitimately hold
 * "California" where the rest of this flow uses "CA". Left alone that reaches
 * the customer's invoice, where a bill-to reading "Los Angeles, California"
 * sits next to a ship-to reading "Los Angeles, CA" and looks like an error.
 *
 * Anything unrecognised passes through UNCHANGED rather than being blanked: a
 * non-US region is not this function's business to destroy.
 */
export function normalizeUSState(value: string | null | undefined): string {
  const raw = clean(value)
  if (raw === '') return ''
  const upper = raw.toUpperCase()
  if (US_STATE_CODES.includes(upper)) return upper
  return STATE_NAME_TO_CODE[upper] ?? raw
}

/**
 * The states as {code, name}, for a picker.
 *
 * Derived from the same two maps the validator uses, so a dropdown can never
 * offer a state the validator would reject. Free-text state fields are what let
 * "California" reach a column whose CHECK constraint only accepts "CA".
 */
export const US_STATES: readonly { code: string; name: string }[] = US_STATE_CODES.map((code) => ({
  code,
  name:
    Object.entries(STATE_NAME_TO_CODE).find(([, c]) => c === code)?.[0].replace(
      /\w\S*/g,
      (w) => w.charAt(0) + w.slice(1).toLowerCase(),
    ) ?? code,
})).sort((a, b) => a.name.localeCompare(b.name))

/**
 * The only country the US invoicing flow supports, as the customer should read
 * it. The database stores "US" and hard-rejects anything else via a CHECK
 * constraint added in 20260902002000; "USA" is the display form.
 */
export const DELIVERY_COUNTRIES: readonly { value: string; label: string }[] = [
  { value: 'US', label: 'USA' },
]

const ZIP_RE = /^\d{5}(-\d{4})?$/
const CONTROL_CHARS_RE = /[\u0000-\u001F\u007F]/g

/** Replace control characters with spaces (a tab between words must separate
 *  them, not glue them) and collapse runs of whitespace to single spaces. */
function clean(value: unknown): string {
  return String(value ?? '')
    .replace(CONTROL_CHARS_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export type SanitizeAddressResult =
  | { ok: true; value: USDeliveryAddress }
  | { ok: false; error: string }

/**
 * Sanitize and validate a US delivery address into TaxJar-ready fields.
 * Accepts full state names ("Maryland") as well as 2-letter codes; zip may be
 * 5-digit or ZIP+4. Every failure names the offending field.
 */
export function sanitizeUSAddress(input: Partial<USDeliveryAddress> | null | undefined): SanitizeAddressResult {
  const street = clean(input?.street)
  const city = clean(input?.city)
  const stateRaw = clean(input?.state).toUpperCase()
  const zip = clean(input?.zip).replace(/ /g, '')

  if (!street) return { ok: false, error: 'Delivery street address is required.' }
  if (street.length > 255) return { ok: false, error: 'Delivery street address is too long (255 characters max).' }
  if (!city) return { ok: false, error: 'Delivery city is required.' }
  if (city.length > 100) return { ok: false, error: 'Delivery city is too long (100 characters max).' }

  const state = US_STATE_CODES.includes(stateRaw) ? stateRaw : STATE_NAME_TO_CODE[stateRaw]
  if (!state) return { ok: false, error: 'Delivery state must be a US state (2-letter code or full name).' }

  if (!ZIP_RE.test(zip)) return { ok: false, error: 'Delivery zip code must be 5 digits (or ZIP+4, e.g. 20794-1234).' }

  return { ok: true, value: { street, city, state, zip } }
}

export interface USAcceptanceFields {
  /** HubSpot win_probability option value, '' when unset. */
  winProbability: string
  /** Will Call: the customer collects from the sending depot. */
  isCollection: boolean
  hasAssociatedCompany: boolean
  delivery: Partial<USDeliveryAddress>
}

/**
 * Whether the Change Stage dialog may submit a US acceptance.
 *
 * A COLLECTED order needs no delivery address: the sale is taxed at the depot
 * the customer collects from, which is exactly how calculate-tax.ts treats
 * customer_invoices.is_collection, and demanding an address the order does not
 * have was what made Will Call impossible to accept from the Hub.
 *
 * A delivered order needs the full address, checked with the SAME sanitizer
 * updateDealStage runs, so the dialog can never enable a submit the server is
 * about to refuse.
 */
export function usAcceptanceComplete(fields: USAcceptanceFields): boolean {
  if (!fields.hasAssociatedCompany) return false
  if (fields.winProbability === '') return false
  if (fields.isCollection) return true
  return sanitizeUSAddress(fields.delivery).ok
}
