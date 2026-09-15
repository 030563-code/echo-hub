/**
 * Why a call was missed.
 *
 * Dean, 15 Sep 2026: "the reps must give a reason for missed calls and before
 * it can sync to hubspot contact". A code from this list plus an optional note,
 * rather than free text alone, so the answer to "how many calls are we missing
 * out of hours, and in which office" is a group-by rather than a reading
 * exercise.
 *
 * The codes are stored; the labels are what a rep picks and what gets written
 * onto the call in HubSpot. Changing a label is safe. Changing a code is a
 * migration, because old rows carry it.
 */

export const MISSED_REASONS = [
  { code: 'nobody_available', label: 'Nobody was available to take it' },
  { code: 'out_of_hours', label: 'Out of hours' },
  { code: 'voicemail_call_back', label: 'Voicemail left, call back booked' },
  { code: 'wrong_number', label: 'Wrong number' },
  { code: 'spam', label: 'Spam or a cold seller' },
  { code: 'not_our_customer', label: 'Not our customer' },
  { code: 'other', label: 'Other' },
] as const

export type MissedReasonCode = (typeof MISSED_REASONS)[number]['code']

export const MISSED_REASON_CODES = MISSED_REASONS.map((r) => r.code) as readonly MissedReasonCode[]

export function isMissedReasonCode(value: string): value is MissedReasonCode {
  return (MISSED_REASON_CODES as readonly string[]).includes(value)
}

export function missedReasonLabel(code: string | null | undefined): string | null {
  const found = MISSED_REASONS.find((r) => r.code === code)
  return found ? found.label : null
}
