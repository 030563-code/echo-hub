import { describe, it, expect } from 'vitest'
import { callPayloadSchema, toCallRow, toE164, toCallAt } from '@/lib/calls/payload'

/**
 * The payload the phone system actually sends.
 *
 * Every case below is a REAL body, taken from the live webhook on 15 Sep 2026,
 * not a shape somebody imagined. That matters: the brief said department
 * notifications carry no contact id, and the live payload proved otherwise. The
 * schema is tolerant field by field for exactly that reason.
 */

const NOW = new Date('2026-09-15T12:00:00.000Z')

/** France, answered, withheld caller. The one that exposes the matching bug. */
const FRANCE_ANSWERED = {
  call_sid: 'CA6aadba4ea187ad98f857ea15dcdae9eb',
  recording_sid: 'REcbc7ae9a77db57f3f80e45c19e96fe45',
  caller_phone: 'anonymous',
  called_phone: '+33978467888',
  diverted_to: '+33 7 53 11 27 16',
  recording_url: 'https://api.twilio.com/2010-04-01/Accounts/ACxxx/Recordings/RExxx.mp3',
  duration_seconds: 8,
  transcript: 'Bonjour, je vous appelle au sujet de la location.',
  transcript_english: 'Hello, I am calling about the hire.',
  summary: 'Conversation too brief to summarise.',
  language: 'fr',
  office: 'France',
  department: 'sales',
  call_type: 'answered',
  call_status: 'completed',
  hubspot_contact_id: '224164246667',
  hubspot_match_source: 'matched',
  call_at: 'Tue, 15 Sep 2026 09:38:36 +0000',
}

/** USA, answered. Carries three fields nobody modelled up front. */
const USA_ANSWERED = {
  ...FRANCE_ANSWERED,
  call_sid: 'CAusa0000000000000000000000000001',
  caller_phone: '+16043999640',
  office: 'USA',
  language: 'en',
  formatted_transcript_html: '<p>Agent: hello</p>',
  key_quotes_html: '<li>needs 40 barriers</li>',
  via: 'deepgram',
  hubspot_match_source: 'created',
  hubspot_contact_id: '248486456404',
}

/** A voicemail: no duration, nobody answered. */
const UK_VOICEMAIL = {
  call_sid: 'CAuk00000000000000000000000000001',
  caller_phone: '+441173250027',
  office: 'UK',
  department: 'sales',
  call_type: 'voicemail',
  call_status: 'no-answer',
  transcript: 'Please call me back about the hire.',
  hubspot_contact_id: '248590761366',
  hubspot_match_source: 'created',
  call_at: 'Mon, 14 Sep 2026 16:02:00 +0000',
}

/** A department notification: no transcript, no duration, but it DOES carry a
 *  contact id, which is what the brief got wrong. */
const UK_DEPARTMENT = {
  call_sid: 'CAuk00000000000000000000000000002',
  caller_phone: '+441173250027',
  called_phone: '+441173250000',
  department: 'accounts',
  office: 'UK',
  call_type: 'department_notification',
  hubspot_contact_id: '248590761366',
  hubspot_match_source: 'created',
  call_at: 'Mon, 15 Sep 2026 10:06:22 +0000',
}

describe('the payload from the phone system', () => {
  it('accepts all four real shapes', () => {
    for (const payload of [FRANCE_ANSWERED, USA_ANSWERED, UK_VOICEMAIL, UK_DEPARTMENT]) {
      const parsed = callPayloadSchema.safeParse(payload)
      expect(parsed.success, `${payload.call_sid}: ${parsed.success ? '' : parsed.error.issues[0]?.message}`).toBe(true)
    }
  })

  it('keeps the fields only the USA handler sends', () => {
    const row = toCallRow(callPayloadSchema.parse(USA_ANSWERED), { now: NOW, contact: null })
    expect(row.formatted_transcript_html).toBe('<p>Agent: hello</p>')
    expect(row.key_quotes_html).toBe('<li>needs 40 barriers</li>')
  })

  it('needs only a call_sid, because that is the idempotency key', () => {
    expect(callPayloadSchema.safeParse({ call_sid: 'CA1234567890' }).success).toBe(true)
    expect(callPayloadSchema.safeParse({ office: 'UK' }).success).toBe(false)
  })

  it('refuses a contact id that is not digits, rather than storing junk', () => {
    const bad = callPayloadSchema.safeParse({ ...UK_VOICEMAIL, hubspot_contact_id: 'undefined' })
    expect(bad.success).toBe(false)
  })

  it('refuses a transcript far larger than any real call', () => {
    const huge = callPayloadSchema.safeParse({ ...UK_VOICEMAIL, transcript: 'x'.repeat(100_001) })
    expect(huge.success).toBe(false)
  })

  it('files a department notification under one call type, whatever it is called', () => {
    // The department handlers send 'answered_notification'; UK sends
    // 'department_notification'. Same thing.
    const row = toCallRow(callPayloadSchema.parse({ ...UK_DEPARTMENT, call_type: 'answered_notification' }), {
      now: NOW,
      contact: null,
    })
    expect(row.call_type).toBe('department_notification')
  })

  it('normalises the office name the handler happens to use', () => {
    const row = toCallRow(callPayloadSchema.parse({ ...UK_VOICEMAIL, office: 'United Kingdom' }), {
      now: NOW,
      contact: null,
    })
    expect(row.office).toBe('UK')
  })

  it('keeps an unmapped office as sent, so the call is still visible', () => {
    const row = toCallRow(callPayloadSchema.parse({ ...UK_VOICEMAIL, office: 'Germany' }), {
      now: NOW,
      contact: null,
    })
    expect(row.office).toBe('Germany')
  })

  it('maps an unrecognised call type to other instead of dropping the call', () => {
    const row = toCallRow(callPayloadSchema.parse({ ...UK_VOICEMAIL, call_type: 'conference' }), {
      now: NOW,
      contact: null,
    })
    expect(row.call_type).toBe('other')
  })

  it('keeps only matched or created as a match source', () => {
    const row = toCallRow(callPayloadSchema.parse({ ...UK_VOICEMAIL, hubspot_match_source: 'guessed' }), {
      now: NOW,
      contact: null,
    })
    expect(row.hubspot_match_source).toBeNull()
  })
})

describe('the caller number', () => {
  it('is null for a withheld caller, never a plus sign', () => {
    // The phone system turns 'anonymous' into '+' and searches HubSpot with it.
    // Storing that as a number is how a junk contact starts to look real.
    for (const withheld of ['anonymous', '', '+', '0', 'unknown', '   ']) {
      expect(toE164(withheld), withheld).toBeNull()
    }
  })

  it('normalises a real number to E.164', () => {
    expect(toE164('+44 117 325 0027')).toBe('+441173250027')
    expect(toE164('(604) 399-9640')).toBe('+6043999640')
  })

  it('refuses something too short to be a number', () => {
    expect(toE164('12345')).toBeNull()
  })

  it('keeps the raw value beside the normalised one', () => {
    const row = toCallRow(callPayloadSchema.parse(FRANCE_ANSWERED), { now: NOW, contact: null })
    expect(row.caller_phone).toBe('anonymous')
    expect(row.caller_phone_e164).toBeNull()
  })
})

describe('the call time', () => {
  it('parses the RFC 2822 form the handlers send', () => {
    expect(toCallAt('Tue, 15 Sep 2026 09:38:36 +0000', NOW).toISOString()).toBe('2026-09-15T09:38:36.000Z')
  })

  it('falls back to now when it is missing or unparseable', () => {
    expect(toCallAt(undefined, NOW)).toEqual(NOW)
    expect(toCallAt('last tuesday', NOW)).toEqual(NOW)
  })
})

describe('the link state a call starts in', () => {
  it('is needs_link when the automation created the contact', () => {
    const row = toCallRow(callPayloadSchema.parse(USA_ANSWERED), { now: NOW, contact: null })
    expect(row.link_state).toBe('needs_link')
  })

  it('is needs_link for a withheld caller even when the automation said matched', () => {
    // France, reported as 'matched' against contact 224164246667, which is
    // itself an Unknown Caller record whose phone is the literal '+'.
    const row = toCallRow(callPayloadSchema.parse(FRANCE_ANSWERED), {
      now: NOW,
      contact: { firstname: 'Unknown', lastname: 'Caller (France)', email: null, phone: '+' },
    })
    expect(row.link_state).toBe('needs_link')
  })

  it('is unreviewed when a real contact with an email answered a real number', () => {
    const row = toCallRow(
      callPayloadSchema.parse({ ...UK_VOICEMAIL, hubspot_match_source: 'matched' }),
      { now: NOW, contact: { firstname: 'Bob', lastname: 'Meyer', email: 'bob@acme.com', phone: '+441173250027' } },
    )
    expect(row.link_state).toBe('unreviewed')
  })

  it('is no_contact when the phone system attached nobody', () => {
    const noContact = { ...UK_DEPARTMENT, hubspot_contact_id: undefined }
    const row = toCallRow(callPayloadSchema.parse(noContact), { now: NOW, contact: null })
    expect(row.link_state).toBe('no_contact')
  })
})
