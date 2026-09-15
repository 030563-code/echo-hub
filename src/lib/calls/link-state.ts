/**
 * Which calls need a person to look at them, and why.
 *
 * The phone system looks a contact up by number and, when it finds nothing,
 * creates one carrying a phone and nothing else: `Unknown / Caller (UK)`,
 * `hs_lead_status NEW`. The rep meanwhile has created the real contact with an
 * email and no phone. Those two records are the same person, and this module
 * decides which calls are sitting on the wrong one.
 *
 * ONE function, used by the ingest endpoint and by the page, so the queue a rep
 * sees and the state stored on the row can never disagree.
 *
 * Rule 4 (a withheld caller is always unreviewed by a human) exists because of
 * a live defect, verified 15 Sep 2026: `Build Phone Variants` in every n8n
 * handler does `rawPhone.replace(/\D/g, '')`, so Twilio's literal `anonymous`
 * collapses to an empty string and the search runs on `["+", "", "0", …]`.
 * HubSpot happily matches a contact whose phone is `+`, and contact
 * 224164246667 (`Unknown Caller (France)`, phone `+`) is what every withheld
 * French call has been reported against, as `matched`. Trusting
 * `hubspot_match_source` alone would hide exactly those calls.
 */

/** A contact as the Hub snapshots it at ingest, or reads it back from HubSpot. */
export interface ContactSnapshot {
  firstname?: string | null
  lastname?: string | null
  email?: string | null
  phone?: string | null
}

export type LinkState = 'unreviewed' | 'needs_link' | 'linked' | 'ignored' | 'no_contact'

export const LINK_STATES: readonly LinkState[] = [
  'unreviewed',
  'needs_link',
  'linked',
  'ignored',
  'no_contact',
]

/** Why a call is in the queue, in words a rep can act on. */
export type LinkReason =
  | 'automation_created_the_contact'
  | 'contact_is_a_placeholder'
  | 'contact_has_no_email'
  | 'caller_withheld_their_number'

export const LINK_REASON_LABELS: Record<LinkReason, string> = {
  automation_created_the_contact: 'The phone system created this contact from the number alone',
  contact_is_a_placeholder: 'The contact is an Unknown Caller placeholder',
  contact_has_no_email: 'The contact has no email address, so nobody can reach them',
  caller_withheld_their_number: 'The caller withheld their number, so the match means nothing',
}

/**
 * True for the records the phone system mints: the name is literally Unknown
 * Caller and there is no email. Both halves matter. A real person called
 * Unknown is not a thing, but a real contact whose surname happens to start
 * with "Caller" and who has an email is, and merging that away would be worse
 * than leaving the call unlinked.
 */
export function isPlaceholderContact(contact: ContactSnapshot | null | undefined): boolean {
  if (!contact) return false
  const first = (contact.firstname ?? '').trim().toLowerCase()
  const last = (contact.lastname ?? '').trim().toLowerCase()
  const hasEmail = (contact.email ?? '').trim() !== ''
  return !hasEmail && first.startsWith('unknown') && last.startsWith('caller')
}

/** A caller id the phone system could not resolve to a number. */
export function isWithheldCaller(callerPhone: string | null | undefined): boolean {
  const raw = (callerPhone ?? '').trim().toLowerCase()
  if (raw === '') return true
  if (raw === 'anonymous' || raw === 'unknown' || raw === 'restricted' || raw === 'private') return true
  // '+' and '0' are what the handler's digit-stripping produces from a withheld
  // caller, and they reach HubSpot as if they were numbers.
  return /^[+0\s-]*$/.test(raw)
}

export interface LinkInput {
  hubspot_contact_id?: string | null
  hubspot_match_source?: string | null
  caller_phone?: string | null
  contact?: ContactSnapshot | null
}

/** Every reason this call needs a person, in the order a rep would read them. */
export function linkReasons(call: LinkInput): LinkReason[] {
  const reasons: LinkReason[] = []
  if ((call.hubspot_match_source ?? '').trim().toLowerCase() === 'created') {
    reasons.push('automation_created_the_contact')
  }
  if (isPlaceholderContact(call.contact)) reasons.push('contact_is_a_placeholder')
  if (call.contact && (call.contact.email ?? '').trim() === '' && !isPlaceholderContact(call.contact)) {
    reasons.push('contact_has_no_email')
  }
  if (isWithheldCaller(call.caller_phone)) reasons.push('caller_withheld_their_number')
  return reasons
}

/**
 * The state a newly ingested call starts in.
 *
 * No contact at all means there is nothing to merge, so it is `no_contact`
 * rather than `needs_link`: the call still shows in the list, but offering a
 * Link button with no placeholder behind it would be a lie.
 */
export function deriveLinkState(call: LinkInput): LinkState {
  const contactId = (call.hubspot_contact_id ?? '').trim()
  if (contactId === '') return 'no_contact'
  return linkReasons(call).length > 0 ? 'needs_link' : 'unreviewed'
}

/** A call nobody answered. The rep must say why before it can be linked. */
export function isMissedCall(call: { call_type?: string | null; call_status?: string | null }): boolean {
  const type = (call.call_type ?? '').trim().toLowerCase()
  const status = (call.call_status ?? '').trim().toLowerCase()
  if (type === 'voicemail') return true
  return ['no-answer', 'no_answer', 'missed', 'busy', 'failed', 'abandoned'].includes(status)
}
