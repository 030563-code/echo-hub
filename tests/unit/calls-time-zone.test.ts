import { afterAll, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'

// The two Calls screens, rendered the way the server renders them. What they
// import beyond formatting (the router, the page-state store, the server
// actions) is stubbed: none of it decides what a time looks like.
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh() {}, push() {} }) }))
vi.mock('@/hooks/use-page-state', () => ({
  usePersistedView: (_key: string, initial: unknown) => [initial, () => {}],
}))
vi.mock('@/app/(dashboard)/calls/actions', () => ({
  recordMissedReason: vi.fn(),
  setCallLinkState: vi.fn(),
  findContactsForCall: vi.fn(),
  linkCallToContact: vi.fn(),
  linkPlaceholderToContact: vi.fn(),
}))

import { callDate, callTime, callWhen } from '@/lib/calls/call-time'
import { CallLogClient } from '@/app/(dashboard)/calls/log/log-client'
import { PlaceholderContactsClient } from '@/app/(dashboard)/calls/contacts/contacts-client'
import type { CallListItem } from '@/lib/calls/board-data'
import type { PlaceholderContact } from '@/lib/calls/placeholders'

/**
 * The Calls page threw React's hydration error (418) at a reader in Paris on
 * every first load: the server (UTC on Netlify) and the browser each formatted
 * a call's time in their own zone, and the two texts differed. What the server
 * renders must not depend on the zone the server process runs in.
 */

// 22:30 UTC on 1 July is already 2 July in Paris, and 03:15 UTC on 15 January
// is still 14 January in New York, so both zones and both sides of midnight
// are exercised. No September date: en-GB has shortened that month two ways
// across ICU versions, which is not what this file is testing.
const LATE_EVENING_UTC = '2026-07-01T22:30:00Z'
const SMALL_HOURS_UTC = '2026-01-15T03:15:00Z'

const ZONES = ['UTC', 'Europe/Paris', 'America/New_York', 'Asia/Tokyo']

const originalTZ = process.env.TZ
afterAll(() => {
  if (originalTZ === undefined) delete process.env.TZ
  else process.env.TZ = originalTZ
})

/** Runs `fn` with the whole process in `zone`, the way a server in that zone would. */
function inProcessZone<T>(zone: string, fn: () => T): T {
  process.env.TZ = zone
  return fn()
}

function call(id: string, callAt: string): CallListItem {
  return {
    id,
    call_sid: `CA-${id}`,
    call_at: callAt,
    office: 'France',
    department: 'sales',
    call_type: 'answered',
    call_status: 'completed',
    caller_phone: '+15555550123',
    caller_phone_e164: '+15555550123',
    duration_seconds: 125,
    language: 'fr',
    rep_email: 'rep@example.com',
    transcript: 'Invented transcript.',
    transcript_english: null,
    summary: 'Asked for a price on ten barriers.',
    recording_url: null,
    hubspot_contact_id: 'contact-1',
    hubspot_match_source: 'phone',
    hubspot_call_id: null,
    contact_firstname: 'Test',
    contact_lastname: 'Caller',
    contact_email: 'caller@example.com',
    contact_phone: '+15555550123',
    link_state: 'needs_link',
    linked_contact_id: null,
    linked_at: null,
    link_note: null,
    missed_reason: null,
    missed_note: null,
    missed_reason_at: null,
    reasons: ['contact_is_a_placeholder'],
    missed: false,
    contactName: 'Test Caller',
  }
}

describe('the process zone really changes between runs', () => {
  it('moves a clock time formatted the old way, so the comparisons below are not vacuous', () => {
    // Exactly what the call log used to do: no zone given, so the process decides.
    const oldWay = () => new Date(LATE_EVENING_UTC).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
    expect(inProcessZone('UTC', oldWay)).toBe('22:30')
    expect(inProcessZone('Europe/Paris', oldWay)).toBe('00:30')
  })
})

describe('call times', () => {
  it('read in the zone they are given, whatever zone the process is in', () => {
    for (const zone of ZONES) {
      inProcessZone(zone, () => {
        expect(callDate(LATE_EVENING_UTC, 'Europe/Paris'), zone).toBe('02 Jul 2026')
        expect(callTime(LATE_EVENING_UTC, 'Europe/Paris'), zone).toBe('00:30')
        expect(callDate(SMALL_HOURS_UTC, 'America/New_York'), zone).toBe('14 Jan 2026')
        expect(callTime(SMALL_HOURS_UTC, 'America/New_York'), zone).toBe('22:15')
        expect(callWhen(SMALL_HOURS_UTC, 'Europe/Paris'), zone).toBe('15 Jan 2026, 04:15')
      })
    }
  })

  it('show UTC, and say so, while the reader has no zone yet', () => {
    for (const zone of ZONES) {
      inProcessZone(zone, () => {
        expect(callDate(LATE_EVENING_UTC, null), zone).toBe('01 Jul 2026')
        expect(callTime(LATE_EVENING_UTC, null), zone).toBe('22:30 UTC')
        expect(callWhen(LATE_EVENING_UTC, null), zone).toBe('01 Jul 2026, 22:30 UTC')
      })
    }
  })

  it('do not label a zone the reader actually chose', () => {
    expect(callTime(LATE_EVENING_UTC, 'UTC')).toBe('22:30')
  })
})

describe('what the server renders for the Calls page', () => {
  it('is the same call log whatever zone the server runs in', () => {
    const page = createElement(CallLogClient, {
      calls: [call('call-1', LATE_EVENING_UTC), call('call-2', SMALL_HOURS_UTC)],
      canSeeNothing: false,
    })
    const html = ZONES.map((zone) => inProcessZone(zone, () => renderToString(page)))
    for (const other of html.slice(1)) expect(other).toBe(html[0])
    // And the one text it renders is UTC, labelled, until the browser takes over.
    expect(html[0]).toContain('22:30 UTC')
    expect(html[0]).toContain('03:15 UTC')
    expect(html[0]).toContain(`dateTime="${LATE_EVENING_UTC}"`)
  })

  it('is the same Needs a contact list whatever zone the server runs in', () => {
    const contact: PlaceholderContact = {
      id: 'contact-2',
      phone: '+15555550199',
      country: 'France',
      createdAt: LATE_EVENING_UTC,
      office: 'France',
      actionable: true,
    }
    const page = createElement(PlaceholderContactsClient, {
      contacts: [contact],
      totalInPortal: 1,
      error: null,
      canSeeNothing: false,
    })
    const html = ZONES.map((zone) => inProcessZone(zone, () => renderToString(page)))
    for (const other of html.slice(1)) expect(other).toBe(html[0])
    expect(html[0]).toContain('01 Jul 2026')
  })
})
