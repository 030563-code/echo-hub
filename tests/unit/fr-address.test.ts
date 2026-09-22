import { describe, it, expect } from 'vitest'
import { sanitizeFRAddress } from '@/lib/fr-address'
import { sanitizeDeliveryAddress, hasStateField, postcodeLabel, acceptanceComplete } from '@/lib/delivery-address'

/**
 * A French address is not a US address with the state left blank.
 *
 * It has no state at all, and its postcode is five digits with no ZIP+4 shape.
 * The old US regex accepted 75008 by accident, which is the kind of match that
 * looks like support and is not. These pin the deliberate version.
 */
describe('sanitizeFRAddress', () => {
  const valid = { street: '25 place de la Madeleine', city: 'Paris', zip: '75008' }

  it('accepts a clean address and carries no state', () => {
    expect(sanitizeFRAddress(valid)).toEqual({ ok: true, value: valid })
  })

  it('cleans whitespace and control characters, and closes a spaced postcode', () => {
    const result = sanitizeFRAddress({ street: ' 25  place\tde la Madeleine ', city: ' Paris ', zip: '75 008' })
    expect(result).toEqual({ ok: true, value: valid })
  })

  it('refuses a ZIP+4 shape, which is not a thing in France', () => {
    const result = sanitizeFRAddress({ ...valid, zip: '75008-1234' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/postcode/i)
  })

  it('refuses malformed postcodes, naming the field', () => {
    for (const zip of ['7500', '750080', 'ABCDE', '']) {
      const result = sanitizeFRAddress({ ...valid, zip })
      expect(result.ok, zip).toBe(false)
      if (!result.ok) expect(result.error).toMatch(/postcode/i)
    }
  })

  it('refuses a missing street or city', () => {
    expect(sanitizeFRAddress({ ...valid, street: '  ' }).ok).toBe(false)
    expect(sanitizeFRAddress({ ...valid, city: '' }).ok).toBe(false)
  })
})

describe('sanitizeDeliveryAddress dispatches by country', () => {
  it('a US address keeps its state and a French one has none', () => {
    const us = sanitizeDeliveryAddress('US', { street: '1218 Broadway', city: 'Santa Monica', state: 'CA', zip: '90404' })
    expect(us).toEqual({ ok: true, value: { street: '1218 Broadway', city: 'Santa Monica', state: 'CA', zip: '90404' } })

    const fr = sanitizeDeliveryAddress('FR', { street: '25 place de la Madeleine', city: 'Paris', state: 'CA', zip: '75008' })
    expect(fr).toEqual({ ok: true, value: { street: '25 place de la Madeleine', city: 'Paris', state: null, zip: '75008' } })
  })

  it('a French postcode does not pass as a US address, and a US zip does not pass as French', () => {
    expect(sanitizeDeliveryAddress('US', { street: 'x', city: 'Paris', state: '', zip: '75008' }).ok).toBe(false)
    expect(sanitizeDeliveryAddress('FR', { street: 'x', city: 'Jessup', zip: '20794-1234' }).ok).toBe(false)
  })

  it('knows which country has a state field and what the postcode is called', () => {
    expect(hasStateField('US')).toBe(true)
    expect(hasStateField('FR')).toBe(false)
    expect(postcodeLabel('US')).toBe('Zip')
    expect(postcodeLabel('FR')).toBe('Postcode')
  })
})

describe('acceptanceComplete, the dialog predicate, in each country', () => {
  const base = { winProbability: '60%', isCollection: false, hasAssociatedCompany: true }

  it('a French delivered acceptance needs street, city and postcode and no state', () => {
    expect(acceptanceComplete('FR', { ...base, delivery: { street: '1 rue X', city: 'Lyon', zip: '69001' } })).toBe(true)
    expect(acceptanceComplete('FR', { ...base, delivery: { street: '1 rue X', city: 'Lyon', zip: '' } })).toBe(false)
  })

  it('still demands the company and the probability, and waives the address on collection', () => {
    expect(acceptanceComplete('FR', { ...base, hasAssociatedCompany: false, delivery: { street: 'x', city: 'y', zip: '75008' } })).toBe(false)
    expect(acceptanceComplete('FR', { ...base, winProbability: '', delivery: { street: 'x', city: 'y', zip: '75008' } })).toBe(false)
    expect(acceptanceComplete('FR', { ...base, isCollection: true, delivery: {} })).toBe(true)
  })
})
