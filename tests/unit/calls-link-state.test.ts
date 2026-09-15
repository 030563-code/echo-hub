import { describe, it, expect } from 'vitest'
import {
  deriveLinkState,
  isMissedCall,
  isPlaceholderContact,
  isWithheldCaller,
  linkReasons,
} from '@/lib/calls/link-state'
import { officesForViewer, OFFICES } from '@/lib/calls/offices'
import { MISSED_REASON_CODES, isMissedReasonCode, missedReasonLabel } from '@/lib/calls/missed-reasons'

describe('a placeholder contact', () => {
  it('is the Unknown Caller record the phone system mints', () => {
    expect(isPlaceholderContact({ firstname: 'Unknown', lastname: 'Caller (UK)', email: null })).toBe(true)
    expect(isPlaceholderContact({ firstname: 'Unknown', lastname: 'Caller (France)', email: '' })).toBe(true)
  })

  it('is not a real person who happens to be called Caller', () => {
    // Both halves of the rule matter. Merging away a real contact because of a
    // surname is worse than leaving a call unlinked.
    expect(isPlaceholderContact({ firstname: 'Unknown', lastname: 'Caller (UK)', email: 'sam@acme.com' })).toBe(false)
    expect(isPlaceholderContact({ firstname: 'Sam', lastname: 'Callero', email: null })).toBe(false)
    expect(isPlaceholderContact(null)).toBe(false)
  })
})

describe('a withheld caller', () => {
  it('covers what Twilio sends and what the handler turns it into', () => {
    // 'anonymous' is what arrives; '+' and '0' are what the handler's
    // digit-stripping produces and then searches HubSpot with.
    for (const value of ['anonymous', 'Anonymous', '', '   ', '+', '0', 'unknown', 'restricted', 'private']) {
      expect(isWithheldCaller(value), value).toBe(true)
    }
  })

  it('does not cover a real number', () => {
    expect(isWithheldCaller('+441173250027')).toBe(false)
  })
})

describe('which calls need a person', () => {
  const realContact = { firstname: 'Bob', lastname: 'Meyer', email: 'bob@acme.com', phone: '+1604' }

  it('flags a contact the automation created', () => {
    expect(
      linkReasons({ hubspot_contact_id: '1', hubspot_match_source: 'created', caller_phone: '+441173250027', contact: realContact }),
    ).toContain('automation_created_the_contact')
  })

  it('flags an older placeholder even without the created flag', () => {
    const reasons = linkReasons({
      hubspot_contact_id: '1',
      hubspot_match_source: 'matched',
      caller_phone: '+441173250027',
      contact: { firstname: 'Unknown', lastname: 'Caller (UK)', email: null },
    })
    expect(reasons).toContain('contact_is_a_placeholder')
  })

  it('flags a contact nobody can email', () => {
    expect(
      linkReasons({ hubspot_contact_id: '1', hubspot_match_source: 'matched', caller_phone: '+44117', contact: { firstname: 'Bob', lastname: 'Meyer', email: '' } }),
    ).toContain('contact_has_no_email')
  })

  it('flags a withheld caller whatever the automation claimed', () => {
    // This is the live defect: the handler searches HubSpot with '+' and gets a
    // junk contact back, then reports the call as matched.
    const reasons = linkReasons({
      hubspot_contact_id: '224164246667',
      hubspot_match_source: 'matched',
      caller_phone: 'anonymous',
      contact: realContact,
    })
    expect(reasons).toEqual(['caller_withheld_their_number'])
    expect(deriveLinkState({ hubspot_contact_id: '224164246667', hubspot_match_source: 'matched', caller_phone: 'anonymous', contact: realContact })).toBe('needs_link')
  })

  it('leaves a clean call alone', () => {
    expect(
      deriveLinkState({ hubspot_contact_id: '1', hubspot_match_source: 'matched', caller_phone: '+441173250027', contact: realContact }),
    ).toBe('unreviewed')
  })

  it('has nothing to link when no contact was attached', () => {
    expect(deriveLinkState({ hubspot_contact_id: null, caller_phone: '+441173250027' })).toBe('no_contact')
  })
})

describe('a missed call', () => {
  it('is a voicemail, or any status that means nobody spoke', () => {
    expect(isMissedCall({ call_type: 'voicemail', call_status: 'no-answer' })).toBe(true)
    expect(isMissedCall({ call_type: 'answered', call_status: 'no-answer' })).toBe(true)
    expect(isMissedCall({ call_type: 'department_notification', call_status: 'busy' })).toBe(true)
    expect(isMissedCall({ call_type: 'answered', call_status: 'completed' })).toBe(false)
  })
})

describe('the missed-call reasons', () => {
  it('are a closed list, so they can be counted later', () => {
    expect(MISSED_REASON_CODES).toEqual([
      'nobody_available',
      'out_of_hours',
      'voicemail_call_back',
      'wrong_number',
      'spam',
      'not_our_customer',
      'other',
    ])
    expect(isMissedReasonCode('out_of_hours')).toBe(true)
    expect(isMissedReasonCode('because')).toBe(false)
    expect(missedReasonLabel('spam')).toBe('Spam or a cold seller')
    expect(missedReasonLabel('nonsense')).toBeNull()
  })
})

describe('which offices a person sees', () => {
  it('follows their pipeline', () => {
    expect(officesForViewer('dfc85d9e-7eb9-4ade-a9cf-4e726cbcc9cc', false)).toEqual(['USA'])
    expect(officesForViewer('2cfa0ec9-937b-44dc-9ee7-146d8745ab33', false)).toEqual(['UK'])
    expect(officesForViewer('14520121', false)).toEqual(['ANZ'])
    expect(officesForViewer('6f942aab-15a9-4cdb-a684-53e78b36c424', false)).toEqual(['Asia'])
  })

  it('gives Euro Sales both of its offices', () => {
    expect(officesForViewer('d739df20-18b4-4e4b-b183-943038071da1', false)).toEqual(['France', 'Spain'])
  })

  it('fails closed on no pipeline, and on one nobody has mapped', () => {
    expect(officesForViewer(null, false)).toEqual([])
    expect(officesForViewer('', false)).toEqual([])
    expect(officesForViewer('a-pipeline-added-next-month', false)).toEqual([])
  })

  it('gives a super admin every office', () => {
    expect(officesForViewer(null, true)).toEqual(OFFICES)
  })
})
