/**
 * What a send is about to do, put in front of a person before they commit.
 *
 * Dean, 16 Sep 2026, after asking whether a "send test email to myself" button
 * would help: "add second confirmation before sending to Manufacturing on the
 * email and the contents of the email as well as confirmation before sending to
 * Cargo partner along with CC everything and where it comes from."
 *
 * The reason this beats a test send is the recipient. A self-addressed test
 * discards the very field somebody can get wrong, so it cannot check it. This
 * shows it instead, every time, along with the copies nobody typed: BAMIDA_PO_BCC
 * is a server setting that never appears on any screen, and a blind copy to an
 * address you have forgotten about is exactly the thing to say out loud.
 *
 * PURE ON PURPOSE. No 'server-only', no import of the recipient resolver, no
 * database. The server actions build these structures and the dialog renders
 * them, so both halves agree on the shape without the client dragging in
 * anything it must not have.
 */

/** Where an address on a send came from. */
export type AddressOrigin =
  /** Somebody typed it into a box on this screen. */
  | 'typed'
  /** A setting on the server. Nobody typed it and no screen shows it. */
  | 'server'
  /** Compiled into the Hub as the fallback when nothing is configured. */
  | 'built-in'
  /** The Hub-wide test override, which replaces the real audience entirely. */
  | 'test-override'

export interface PreviewAddress {
  address: string
  origin: AddressOrigin
  /** Named so a reader can go and change it: a box on screen, or the setting. */
  from: string
}

/** One label and value in the "what this email carries" block. */
export interface PreviewFact {
  label: string
  value: string
  /** Long values (a URL) take the whole row rather than wrapping in a column. */
  wide?: boolean
}

/** A product line as the email will list it. Never a SKU: those are ours. */
export interface PreviewLine {
  name: string
  quantity: string
}

export interface SendPreview {
  /** Plain words for what is about to happen, e.g. "a purchase order to the manufacturer". */
  what: string
  to: PreviewAddress[]
  cc: PreviewAddress[]
  bcc: PreviewAddress[]
  /** True while the Hub-wide test override is diverting every email. */
  isTest: boolean
  /** On a diverted send, who it would have reached. Null on a real one. */
  instead: { to: string[]; cc: string[]; bcc: string[] } | null
  facts: PreviewFact[]
  lines: PreviewLine[]
  /** Anything a person should read twice before pressing send. */
  warnings: string[]
}

/**
 * Split one configured or typed value into addresses, all sharing an origin.
 *
 * The caller knows where the string came from, so nothing here has to guess by
 * matching an address back against a list of settings. A guess would be wrong
 * the first time somebody types an address that also happens to be configured.
 */
export function addressesFrom(
  value: string | null | undefined,
  origin: AddressOrigin,
  from: string,
): PreviewAddress[] {
  const seen = new Set<string>()
  const out: PreviewAddress[] = []
  for (const piece of String(value ?? '').split(',')) {
    const address = piece.trim()
    if (!address) continue
    const key = address.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ address, origin, from })
  }
  return out
}

/** How an origin reads on screen, in the fewest words that still say where to go. */
export const ORIGIN_LABELS: Record<AddressOrigin, string> = {
  typed: 'typed here',
  server: 'server setting',
  'built-in': 'Hub default',
  'test-override': 'test override',
}
