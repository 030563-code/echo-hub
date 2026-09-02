import { describe, it, expect, afterEach } from 'vitest'
import { hubspotRecordUrl } from '@/lib/hubspot-links'

const ORIGINAL = process.env.NEXT_PUBLIC_HUBSPOT_PORTAL_ID
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.NEXT_PUBLIC_HUBSPOT_PORTAL_ID
  else process.env.NEXT_PUBLIC_HUBSPOT_PORTAL_ID = ORIGINAL
})

describe('hubspotRecordUrl', () => {
  it('builds the durable object-type URL for each record kind', () => {
    process.env.NEXT_PUBLIC_HUBSPOT_PORTAL_ID = '3882358'
    expect(hubspotRecordUrl('deal', '123')).toBe('https://app.hubspot.com/contacts/3882358/record/0-3/123')
    expect(hubspotRecordUrl('company', '456')).toBe('https://app.hubspot.com/contacts/3882358/record/0-2/456')
    expect(hubspotRecordUrl('contact', '789')).toBe('https://app.hubspot.com/contacts/3882358/record/0-1/789')
  })

  it('returns null with no portal id, rather than a URL that 404s', () => {
    delete process.env.NEXT_PUBLIC_HUBSPOT_PORTAL_ID
    expect(hubspotRecordUrl('deal', '123')).toBeNull()
  })

  it('returns null for a missing or blank record id', () => {
    process.env.NEXT_PUBLIC_HUBSPOT_PORTAL_ID = '3882358'
    expect(hubspotRecordUrl('company', null)).toBeNull()
    expect(hubspotRecordUrl('company', undefined)).toBeNull()
    expect(hubspotRecordUrl('company', '  ')).toBeNull()
  })
})
