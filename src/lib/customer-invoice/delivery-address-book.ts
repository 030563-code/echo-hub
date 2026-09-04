/**
 * Remembered ship-to addresses, per customer.
 *
 * Some customers deliver to the same yard every time; others, like a national
 * rental firm, have dozens of depots and a rep retypes one of them on every
 * invoice. This is the pure half of letting them pick instead: which book an
 * invoice belongs to, when two saved addresses are the same address, and how one
 * reads in a dropdown.
 *
 * No fetch, no clock, no database. Everything here is decided from values the
 * caller already holds, which is what makes the dedupe rule testable.
 */

export interface DeliveryAddressInput {
  street?: string | null
  city?: string | null
  state?: string | null
  zip?: string | null
  country?: string | null
  /** Optional site or depot label at that address, e.g. "Location G52". */
  location?: string | null
  /** Optional name of whoever asked for the delivery. */
  requestedBy?: string | null
}

export interface SavedDeliveryAddress extends DeliveryAddressInput {
  id: string
  lastUsedAt?: string | null
}

/**
 * Which address book an invoice belongs to.
 *
 * The Xero account code is preferred, because Dean asked for this per Xero
 * contact and that code is what Xero itself keys on. It is NOT reliable on its
 * own: open-invoice.ts takes it from account_registry.usa_xero_account_code,
 * which is nullable, so a customer that has never been coded in Xero would
 * otherwise share one giant null book with every other uncoded customer. The
 * HubSpot company id is the fallback, and null means no book at all rather than
 * a shared one.
 */
export function deliveryContactKey(
  xeroAccountCode: string | null | undefined,
  hubspotCompanyId: string | null | undefined,
): string | null {
  const xero = String(xeroAccountCode ?? '').trim()
  if (xero !== '') return `xero:${xero}`
  const company = String(hubspotCompanyId ?? '').trim()
  if (company !== '') return `hs:${company}`
  return null
}

/** Collapse runs of whitespace and trim, so "12  Main  St " matches "12 Main St". */
function squash(value: string | null | undefined): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim()
}

/**
 * The dedupe key for one saved address.
 *
 * Case and spacing are normalised because the same yard gets typed six ways.
 * The location IS part of it: two units at one street address really are two
 * delivery points, and a rental firm's G52 and G92 must both be offerable.
 *
 * requestedBy is deliberately NOT part of it. The same depot requested by two
 * different people is one address. Folding the name in would grow the dropdown
 * by one entry per person who ever ordered, which is the opposite of the point.
 */
export function deliveryAddressFingerprint(address: DeliveryAddressInput): string {
  return [
    squash(address.street),
    squash(address.city),
    squash(address.state),
    squash(address.zip),
    squash(address.country) || 'US',
    squash(address.location),
  ]
    .join('|')
    .toLowerCase()
}

/**
 * Is there enough here to be worth remembering?
 *
 * A half-typed address saved by accident is worse than nothing: it sits in the
 * dropdown forever and a rep eventually picks it. Street, city, state and zip
 * are exactly the four TaxJar needs, so anything the book offers is also
 * something tax can be calculated against.
 */
export function isSaveableDeliveryAddress(address: DeliveryAddressInput): boolean {
  return (
    squash(address.street) !== '' &&
    squash(address.city) !== '' &&
    squash(address.state) !== '' &&
    squash(address.zip) !== ''
  )
}

/**
 * One line for the dropdown.
 *
 * The location leads when there is one, because that is what a rep at a rental
 * firm recognises: they are looking for G52, not for the street it sits on.
 */
export function deliveryAddressLabel(address: DeliveryAddressInput): string {
  const location = squash(address.location)
  const street = squash(address.street)
  const cityState = [squash(address.city), squash(address.state)].filter((p) => p !== '').join(', ')
  const tail = [cityState, squash(address.zip)].filter((p) => p !== '').join(' ')
  const place = [street, tail].filter((p) => p !== '').join(', ')
  return location === '' ? place : `${location} — ${place}`
}

/**
 * The SHIP TO block as printed lines, location under the street and the
 * requester at the foot, which is where Dean asked for them.
 *
 * Returns lines only for what is actually set: an invoice with no location and
 * no requester prints exactly what it printed before this existed.
 */
export function deliveryAddressLines(address: DeliveryAddressInput): string[] {
  const lines: string[] = []
  const street = squash(address.street)
  if (street !== '') lines.push(street)
  const location = squash(address.location)
  if (location !== '') lines.push(location)
  const cityState = [squash(address.city), squash(address.state)].filter((p) => p !== '').join(', ')
  const tail = [cityState, squash(address.zip)].filter((p) => p !== '').join(' ')
  if (tail !== '') lines.push(tail)
  return lines
}

/** The requester line, or null when nobody was named. */
export function requestedByLine(requestedBy: string | null | undefined): string | null {
  const name = squash(requestedBy)
  return name === '' ? null : `Requested by: ${name}`
}
