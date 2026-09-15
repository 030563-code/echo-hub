import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import { linkReasons, isMissedCall, type LinkReason, type LinkState } from './link-state'
import type { Office } from './offices'

/**
 * What the calls page reads.
 *
 * Server-only, and it takes the admin client from its caller, which must have
 * checked the capability first. Same shape as src/lib/stock/board-data.ts: the
 * table is closed to anon and authenticated, so every read of it is a
 * deliberate, already-authorised one.
 */

/** Recent calls, plus every call still waiting for a person whatever its age. */
const RECENT_DAYS = 60
const RECENT_LIMIT = 400
const QUEUE_LIMIT = 200

export interface CallRow {
  id: string
  call_sid: string
  call_at: string
  office: string
  department: string
  call_type: string
  call_status: string | null
  caller_phone: string | null
  caller_phone_e164: string | null
  duration_seconds: number | null
  language: string | null
  rep_email: string | null
  transcript: string | null
  transcript_english: string | null
  summary: string | null
  recording_url: string | null
  hubspot_contact_id: string | null
  hubspot_match_source: string | null
  hubspot_call_id: string | null
  contact_firstname: string | null
  contact_lastname: string | null
  contact_email: string | null
  contact_phone: string | null
  link_state: LinkState
  linked_contact_id: string | null
  linked_at: string | null
  link_note: string | null
  missed_reason: string | null
  missed_note: string | null
  missed_reason_at: string | null
}

export interface CallListItem extends CallRow {
  /** Why this call is in the queue, in words. Derived, never stored, so it can
   *  never drift from the contact snapshot beside it. */
  reasons: LinkReason[]
  missed: boolean
  contactName: string | null
}

const COLUMNS =
  'id, call_sid, call_at, office, department, call_type, call_status, caller_phone, caller_phone_e164, ' +
  'duration_seconds, language, rep_email, transcript, transcript_english, summary, recording_url, ' +
  'hubspot_contact_id, hubspot_match_source, hubspot_call_id, contact_firstname, contact_lastname, ' +
  'contact_email, contact_phone, link_state, linked_contact_id, linked_at, link_note, ' +
  'missed_reason, missed_note, missed_reason_at'

function decorate(row: CallRow): CallListItem {
  const name = [row.contact_firstname, row.contact_lastname].filter(Boolean).join(' ').trim()
  return {
    ...row,
    reasons: linkReasons({
      hubspot_contact_id: row.hubspot_contact_id,
      hubspot_match_source: row.hubspot_match_source,
      caller_phone: row.caller_phone,
      contact: {
        firstname: row.contact_firstname,
        lastname: row.contact_lastname,
        email: row.contact_email,
        phone: row.contact_phone,
      },
    }),
    missed: isMissedCall(row),
    contactName: name === '' ? null : name,
  }
}

export interface CallsBoard {
  calls: CallListItem[]
  counts: { all: number; needsLink: number; linked: number; noContact: number }
  offices: readonly Office[]
}

/**
 * The calls this viewer may see.
 *
 * An empty office list means exactly that: no calls. It is what a person with
 * no pipeline gets, and returning everything instead would quietly undo the
 * scoping for the very people it exists for.
 */
export async function loadCallsBoard(
  admin: SupabaseClient,
  offices: readonly Office[],
): Promise<CallsBoard> {
  if (offices.length === 0) {
    return { calls: [], counts: { all: 0, needsLink: 0, linked: 0, noContact: 0 }, offices }
  }

  const since = new Date(Date.now() - RECENT_DAYS * 24 * 60 * 60 * 1000).toISOString()

  const [recent, queue] = await Promise.all([
    admin
      .from('hub_calls')
      .select(COLUMNS)
      .in('office', offices as string[])
      .gte('call_at', since)
      .order('call_at', { ascending: false })
      .limit(RECENT_LIMIT),
    // Separately, because a call still waiting for a person is work however old
    // it is, and a date window that hides the backlog defeats the page.
    admin
      .from('hub_calls')
      .select(COLUMNS)
      .in('office', offices as string[])
      .eq('link_state', 'needs_link')
      .lt('call_at', since)
      .order('call_at', { ascending: false })
      .limit(QUEUE_LIMIT),
  ])

  if (recent.error) {
    console.error('loadCallsBoard could not read the recent calls', recent.error.message)
  }
  if (queue.error) {
    console.error('loadCallsBoard could not read the older queue', queue.error.message)
  }

  const seen = new Set<string>()
  const calls = [...((recent.data ?? []) as unknown as CallRow[]), ...((queue.data ?? []) as unknown as CallRow[])]
    .filter((row) => (seen.has(row.id) ? false : (seen.add(row.id), true)))
    .map(decorate)

  return {
    calls,
    counts: {
      all: calls.length,
      needsLink: calls.filter((c) => c.link_state === 'needs_link').length,
      linked: calls.filter((c) => c.link_state === 'linked').length,
      noContact: calls.filter((c) => c.link_state === 'no_contact').length,
    },
    offices,
  }
}
