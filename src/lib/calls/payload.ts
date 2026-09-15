/**
 * The call payload the phone system sends, and what the Hub keeps of it.
 *
 * Every country handler on the telephony side posts the same webhook, but not
 * the same fields: the USA handler adds formatted HTML and key quotes, a
 * voicemail carries no duration, a department notification carries no
 * transcript at all. So the shape is tolerant FIELD BY FIELD rather than by
 * call type. Only `call_sid` is genuinely required, because it is the
 * idempotency key, and a payload without it cannot be stored twice safely.
 *
 * A pure module on purpose: the four real payloads can be parsed in a unit test
 * with no server, no database and no network.
 */

import { z } from 'zod'
import { deriveLinkState, type LinkState } from './link-state'
import { normaliseOffice } from './offices'

/** What the phone system calls a call. Anything else becomes 'other'. */
export const CALL_TYPES = ['answered', 'voicemail', 'department_notification', 'other'] as const
export type CallType = (typeof CALL_TYPES)[number]

const text = (max: number) => z.string().trim().max(max)

export const callPayloadSchema = z
  .object({
    // Twilio's own id. Not pinned to /^CA/: a format change upstream must not
    // start dropping calls on the floor.
    call_sid: z.string().trim().min(8).max(64),
    recording_sid: text(64).optional(),
    caller_phone: text(64).optional(),
    called_phone: text(64).optional(),
    diverted_to: text(64).optional(),
    recording_url: text(1000).optional(),
    duration_seconds: z.coerce.number().int().min(0).max(86_400).optional(),
    transcript: text(100_000).optional(),
    transcript_english: text(100_000).optional(),
    summary: text(20_000).optional(),
    formatted_transcript_html: text(200_000).optional(),
    key_quotes_html: text(200_000).optional(),
    via: text(200).optional(),
    language: text(16).optional(),
    office: text(64).optional(),
    department: text(64).optional(),
    call_type: text(64).optional(),
    call_status: text(64).optional(),
    rep_email: text(320).optional(),
    // Digits only. Junk here is dropped rather than stored, because every later
    // HubSpot call would be built from it.
    hubspot_contact_id: z
      .string()
      .trim()
      .regex(/^\d{1,20}$/)
      .optional(),
    hubspot_match_source: text(32).optional(),
    call_at: text(64).optional(),
  })
  // Unknown keys are ignored here and kept whole in raw_payload, so a field
  // somebody adds upstream is never lost just because the Hub has not modelled
  // it yet.
  .passthrough()

export type CallPayload = z.infer<typeof callPayloadSchema>

/** A caller id that is a real number, or null. 'anonymous' is not a number. */
export function toE164(raw: string | null | undefined): string | null {
  const value = (raw ?? '').trim()
  if (value === '') return null
  const digits = value.replace(/\D/g, '')
  // Fewer than 7 digits is not a phone number anywhere. This is what stops
  // 'anonymous' (0 digits) and the handler's own '+' and '0' artefacts from
  // being stored as if they were numbers.
  if (digits.length < 7 || digits.length > 15) return null
  return `+${digits}`
}

/**
 * The call time. The handlers send RFC 2822 ("Tue, 15 Sep 2026 09:38:36 +0000")
 * and an unparseable or absent value falls back to now, because a call the Hub
 * cannot date is still a call the rep has to deal with.
 */
export function toCallAt(raw: string | null | undefined, now: Date): Date {
  const value = (raw ?? '').trim()
  if (value === '') return now
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? now : parsed
}

function normaliseCallType(raw: string | null | undefined): CallType {
  const value = (raw ?? '').trim().toLowerCase()
  // The department handlers send 'answered_notification' for a call that reached
  // accounts or transport. It is the same thing as a department notification and
  // belongs in the same bucket, rather than falling into 'other'.
  if (value === 'answered_notification') return 'department_notification'
  return (CALL_TYPES as readonly string[]).includes(value) ? (value as CallType) : 'other'
}

function normaliseMatchSource(raw: string | null | undefined): 'matched' | 'created' | null {
  const value = (raw ?? '').trim().toLowerCase()
  return value === 'matched' || value === 'created' ? value : null
}

/** What actually gets written. A closed list of columns, never the raw body. */
export interface CallRow {
  call_sid: string
  recording_sid: string | null
  office: string
  department: string
  call_type: CallType
  call_status: string | null
  caller_phone: string | null
  caller_phone_e164: string | null
  called_phone: string | null
  diverted_to: string | null
  duration_seconds: number | null
  language: string | null
  transcript: string | null
  transcript_english: string | null
  summary: string | null
  formatted_transcript_html: string | null
  key_quotes_html: string | null
  recording_url: string | null
  rep_email: string | null
  call_at: string
  hubspot_contact_id: string | null
  hubspot_match_source: string | null
  link_state: LinkState
  raw_payload: unknown
}

const nullIfBlank = (value: string | undefined): string | null => {
  const trimmed = (value ?? '').trim()
  return trimmed === '' ? null : trimmed
}

/**
 * Payload to row. `contact` is the snapshot read back from HubSpot when the
 * payload named one, and it is what lets the link state see a placeholder that
 * the automation reported as a match.
 */
export function toCallRow(
  payload: CallPayload,
  options: { now: Date; contact?: { firstname?: string | null; lastname?: string | null; email?: string | null; phone?: string | null } | null },
): CallRow {
  const callerPhone = nullIfBlank(payload.caller_phone)
  const contactId = nullIfBlank(payload.hubspot_contact_id)
  const matchSource = normaliseMatchSource(payload.hubspot_match_source)

  return {
    call_sid: payload.call_sid.trim(),
    recording_sid: nullIfBlank(payload.recording_sid),
    // The handlers each name their own office ("United Kingdom", "France"), so
    // the raw value is mapped to one name here. An office nobody has mapped is
    // kept as sent, so it shows up rather than disappearing.
    office: normaliseOffice(payload.office) ?? nullIfBlank(payload.office) ?? 'Unknown',
    department: nullIfBlank(payload.department) ?? 'unknown',
    call_type: normaliseCallType(payload.call_type),
    call_status: nullIfBlank(payload.call_status),
    caller_phone: callerPhone,
    caller_phone_e164: toE164(callerPhone),
    called_phone: nullIfBlank(payload.called_phone),
    diverted_to: nullIfBlank(payload.diverted_to),
    duration_seconds: payload.duration_seconds ?? null,
    language: nullIfBlank(payload.language),
    transcript: nullIfBlank(payload.transcript),
    transcript_english: nullIfBlank(payload.transcript_english),
    summary: nullIfBlank(payload.summary),
    formatted_transcript_html: nullIfBlank(payload.formatted_transcript_html),
    key_quotes_html: nullIfBlank(payload.key_quotes_html),
    recording_url: nullIfBlank(payload.recording_url),
    rep_email: nullIfBlank(payload.rep_email)?.toLowerCase() ?? null,
    call_at: toCallAt(payload.call_at, options.now).toISOString(),
    hubspot_contact_id: contactId,
    hubspot_match_source: matchSource,
    link_state: deriveLinkState({
      hubspot_contact_id: contactId,
      hubspot_match_source: matchSource,
      caller_phone: callerPhone,
      contact: options.contact ?? null,
    }),
    raw_payload: payload,
  }
}
