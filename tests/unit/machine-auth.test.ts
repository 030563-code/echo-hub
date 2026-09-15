import { describe, it, expect } from 'vitest'
import { bearerAuthorized } from '@/lib/machine-auth'

/**
 * The check on every machine endpoint (the MRP cron, the phone system's call
 * feed). It had no test while it lived inside the MRP route; it has one now,
 * because the property that matters most is the one that is invisible when it
 * breaks: an unset secret must reject everything rather than run open.
 */
describe('bearerAuthorized', () => {
  it('rejects everything when the secret is unset', () => {
    expect(bearerAuthorized('Bearer anything', undefined)).toBe(false)
    expect(bearerAuthorized('Bearer ', '')).toBe(false)
    expect(bearerAuthorized(null, undefined)).toBe(false)
  })

  it('accepts only the exact header', () => {
    expect(bearerAuthorized('Bearer s3cret', 's3cret')).toBe(true)
  })

  it('rejects a bare secret with no scheme', () => {
    expect(bearerAuthorized('s3cret', 's3cret')).toBe(false)
  })

  it('rejects a prefix, a suffix and a different case', () => {
    expect(bearerAuthorized('Bearer s3cre', 's3cret')).toBe(false)
    expect(bearerAuthorized('Bearer s3crets', 's3cret')).toBe(false)
    expect(bearerAuthorized('bearer s3cret', 's3cret')).toBe(false)
  })

  it('rejects a missing header', () => {
    expect(bearerAuthorized(null, 's3cret')).toBe(false)
    expect(bearerAuthorized(undefined, 's3cret')).toBe(false)
  })
})
