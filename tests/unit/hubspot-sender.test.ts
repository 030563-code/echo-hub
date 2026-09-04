import { describe, it, expect } from 'vitest'
import { ownerSignatureName } from '@/lib/hubspot-owners'

/**
 * The signature under "Thanks," in a quote email. It has to be the name on the
 * HubSpot account the mail is sent from, not the Hub's own profiles row: the
 * two drift, and a quote went out signed with a colleague's name.
 */
describe('ownerSignatureName', () => {
  it('joins the HubSpot owner first and last name', () => {
    expect(ownerSignatureName({ firstName: 'Jillian', lastName: 'Rocco' })).toBe('Jillian Rocco')
  })

  it('accepts a first name alone', () => {
    expect(ownerSignatureName({ firstName: 'Jillian', lastName: null })).toBe('Jillian')
  })

  // null, not a placeholder: the caller falls back to the Hub profile rather
  // than printing "Owner 12345" or an email address to a customer.
  it('returns null when HubSpot has no name, so the caller can fall back', () => {
    expect(ownerSignatureName({ firstName: '', lastName: '  ', email: 'j@x.com' })).toBeNull()
    expect(ownerSignatureName(null)).toBeNull()
    expect(ownerSignatureName(undefined)).toBeNull()
  })
})
