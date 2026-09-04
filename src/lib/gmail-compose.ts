/**
 * Gmail compose links for sending a published quote to the customer.
 *
 * v1 is a prefilled Gmail compose window rather than an API send: no OAuth, no
 * service account, no n8n, so every rep has it on the day it ships.
 *
 * No BCC. The Hub used to put a configured logging address on the BCC line, and
 * the address configured was a colleague's own mailbox, so every quote quietly
 * copied him. HubSpot already logs mail sent from a connected inbox against the
 * contact, its company and the deal, which is the outcome the BCC was there to
 * produce, so the parameter is gone rather than re-pointed.
 *
 * Pure by design: no fetch, no env lookup, no clock. The rep's details and the
 * already-formatted expiry date all arrive as parameters, which is also what
 * makes the customer-facing copy testable.
 */

const COMPOSE_BASE = 'https://mail.google.com/mail/?view=cm&fs=1'

export interface GmailComposeParams {
  to?: string | null
  cc?: string | null
  subject?: string | null
  body?: string | null
  authuser?: string | null
}

/**
 * view=cm and fs=1 are fixed and always come first in that order, so two URLs
 * for the same quote diff cleanly and a pasted link in a bug report can be read
 * at a glance.
 *
 * An empty value is dropped rather than emitted as `to=`, which Gmail turns
 * into an empty recipient chip the rep then has to delete. Values are trimmed
 * before encoding because a pasted address usually carries a leading space, and
 * nothing generated here depends on edge whitespace.
 */
export function buildGmailComposeUrl(params: GmailComposeParams): string {
  const query: string[] = []
  const append = (key: string, value: string | null | undefined) => {
    const trimmed = String(value ?? '').trim()
    if (!trimmed) return
    query.push(`${key}=${encodeURIComponent(trimmed)}`)
  }

  append('to', params.to)
  append('cc', params.cc)
  // Gmail's subject parameter is `su`. `subject=` is silently ignored.
  append('su', params.subject)
  // encodeURIComponent turns newlines into %0A, which is the only line break
  // Gmail's compose window honours in a body parameter.
  append('body', params.body)
  // Picks which signed-in account composes. Without it, a rep signed into two
  // Google accounts can send from the wrong one, and HubSpot then logs nothing
  // because the sending address is not the connected inbox.
  append('authuser', params.authuser)

  return query.length === 0 ? COMPOSE_BASE : `${COMPOSE_BASE}&${query.join('&')}`
}

export interface QuoteEmailInput {
  contactFirstName?: string | null
  companyName?: string | null
  dealName: string
  quoteNumber?: string | null
  quoteLink: string
  /** Already formatted for the reader, e.g. '30 September 2026'. This module
   *  stays clock-free and locale-free, so the caller decides the wording. */
  expiresOn?: string | null
  repName?: string | null
  repPhone?: string | null
}

export interface QuoteEmail {
  subject: string
  body: string
}

/**
 * Collapse to a single trimmed line. Every field here arrives from HubSpot
 * unsanitised, and a deal name pasted in with a line break would otherwise
 * split the subject across two lines, which is a header-injection shape rather
 * than a display nuisance.
 */
function oneLine(value: string | null | undefined): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim()
}

/**
 * The customer-facing subject and plain-text body.
 *
 * Subject reads 'Echo Barrier quote EBUS26123 for Sun Valley Pickleball
 * Courts', and drops whichever half is unknown instead of leaving a dangling
 * 'for ' or a bare number. Body is deliberately plain: no marketing language
 * and no exclamation marks, because this goes out under a rep's own name to a
 * customer who has just asked for a price.
 *
 * Kept well under 1000 characters. The whole thing is percent-encoded into a
 * URL, and browsers start truncating long ones, so length here is correctness
 * rather than taste.
 */
export function buildQuoteEmail(input: QuoteEmailInput): QuoteEmail {
  const dealName = oneLine(input.dealName)
  const quoteNumber = oneLine(input.quoteNumber)
  const company = oneLine(input.companyName)
  const firstName = oneLine(input.contactFirstName)
  const expiresOn = oneLine(input.expiresOn)
  const repName = oneLine(input.repName)
  const repPhone = oneLine(input.repPhone)
  const link = oneLine(input.quoteLink)

  let subject = 'Echo Barrier quote'
  if (quoteNumber) subject += ` ${quoteNumber}`
  if (dealName) subject += ` for ${dealName}`

  const lines: string[] = []
  lines.push(`${firstName ? `Hi ${firstName}` : 'Hi there'},`)
  lines.push('')
  lines.push(company ? `Your Echo Barrier quote for ${company} is ready.` : 'Your Echo Barrier quote is ready.')

  // Each optional block carries its own blank line, so an unknown expiry or an
  // unsigned rep leaves no orphan gap in the sent email.
  if (link) {
    lines.push('')
    lines.push(link)
  }
  if (expiresOn) {
    lines.push('')
    lines.push(`The quote is valid until ${expiresOn}.`)
  }

  lines.push('')
  lines.push('Let me know if you have any questions, or if anything needs changing before you accept it.')

  if (repName || repPhone) {
    lines.push('')
    lines.push('Thanks,')
    if (repName) lines.push(repName)
    if (repPhone) lines.push(repPhone)
  }

  return { subject, body: lines.join('\n') }
}
