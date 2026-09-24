import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  sanitizeCAAddress,
  normalizeCAPostalCode,
  CA_PROVINCES,
  CA_PROVINCE_CODES,
  CA_POSTAL_CODE_PATTERN,
  CA_DELIVERY_COUNTRIES,
} from '@/lib/ca-address'
import {
  sanitizeDeliveryAddress,
  hasStateField,
  stateLabel,
  stateOptionsFor,
  postcodeLabel,
  postcodeExample,
  postcodeProblem,
  deliveryCountriesFor,
  acceptanceComplete,
} from '@/lib/delivery-address'

/**
 * Canadian delivery addresses. The province decides Canadian sales tax, so a
 * wrong one is a tax error, and the postal code is stored in one spelling so the
 * address book cannot hold the same yard twice. Every address here is invented.
 */

const VALID = { street: '12 Invented Road', city: 'Faketown', province: 'ON', postalCode: 'M9X 9Z9' }

describe('sanitizeCAAddress', () => {
  it('knows exactly the ten provinces and three territories Canada Post codes', () => {
    expect([...CA_PROVINCE_CODES].sort()).toEqual(['AB', 'BC', 'MB', 'NB', 'NL', 'NS', 'NT', 'NU', 'ON', 'PE', 'QC', 'SK', 'YT'])
    expect(CA_PROVINCES.map((p) => p.code)).toEqual([...CA_PROVINCE_CODES])
    // Name order for the picker.
    const names = CA_PROVINCES.map((p) => p.name)
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)))
  })

  it('accepts every province and territory by code, in any case, and by full name', () => {
    for (const { code, name } of CA_PROVINCES) {
      expect(sanitizeCAAddress({ ...VALID, province: code }), code).toEqual({ ok: true, value: { ...VALID, province: code } })
      expect(sanitizeCAAddress({ ...VALID, province: code.toLowerCase() }), code).toEqual({ ok: true, value: { ...VALID, province: code } })
      expect(sanitizeCAAddress({ ...VALID, province: ` ${name.toUpperCase()} ` }), name).toEqual({ ok: true, value: { ...VALID, province: code } })
    }
  })

  it('reads Quebec written in French, and the short names people use', () => {
    expect(sanitizeCAAddress({ ...VALID, province: 'Québec' })).toEqual({ ok: true, value: { ...VALID, province: 'QC' } })
    expect(sanitizeCAAddress({ ...VALID, province: 'Newfoundland' })).toEqual({ ok: true, value: { ...VALID, province: 'NL' } })
    expect(sanitizeCAAddress({ ...VALID, province: 'Yukon Territory' })).toEqual({ ok: true, value: { ...VALID, province: 'YT' } })
  })

  it('🔴 refuses CA, which is California and the country code, never a province', () => {
    const r = sanitizeCAAddress({ ...VALID, province: 'CA' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/province/i)
  })

  it('refuses a US state, a blank and anything else', () => {
    for (const province of ['TX', 'California', '', '  ', 'Ontari', 'XX']) {
      expect(sanitizeCAAddress({ ...VALID, province }).ok, province).toBe(false)
    }
  })

  it('stores the postal code the way Canada Post prints it, whatever the spacing and case', () => {
    for (const typed of ['m9x9z9', 'M9X9Z9', 'm9x 9z9', ' M9X  9Z9 ', 'M9X\t9Z9']) {
      expect(sanitizeCAAddress({ ...VALID, postalCode: typed }), typed).toEqual({ ok: true, value: VALID })
    }
  })

  it('refuses a postal code Canada Post could never issue', () => {
    for (const bad of [
      'W9X 9Z9', // W never first
      'Z9X 9Z9', // Z never first
      'D9X 9Z9', // D never anywhere
      'M9D 9Z9',
      'M9X 9O9', // O, typed for a zero
      'M9X 9Q9',
      'M9X 9Z', // short
      'M9X 9Z99', // long
      '99X 9Z9', // digit first
      'MXX 9Z9', // letter where a digit goes
      'M9X-9Z9', // a hyphen is not a space
      '20794', // a US zip
      '75008', // a French code postal
      '',
    ]) {
      const r = sanitizeCAAddress({ ...VALID, postalCode: bad })
      expect(r.ok, bad).toBe(false)
      if (!r.ok) expect(r.error, bad).toBe('Delivery postal code must be in the form A1A 1A1.')
    }
  })

  it('names the field at fault, in the same words as the US and French sanitizers', () => {
    expect(sanitizeCAAddress({ ...VALID, street: '  ' })).toEqual({ ok: false, error: 'Delivery street address is required.' })
    expect(sanitizeCAAddress({ ...VALID, city: '' })).toEqual({ ok: false, error: 'Delivery city is required.' })
    expect(sanitizeCAAddress({ ...VALID, street: 'x'.repeat(256) })).toEqual({
      ok: false,
      error: 'Delivery street address is too long (255 characters max).',
    })
    expect(sanitizeCAAddress({ ...VALID, city: 'x'.repeat(101) })).toEqual({ ok: false, error: 'Delivery city is too long (100 characters max).' })
    expect(sanitizeCAAddress(null).ok).toBe(false)
  })

  it('cleans control characters and runs of spaces out of the street and city', () => {
    const r = sanitizeCAAddress({ ...VALID, street: '12\tInvented   Road', city: ' Faketown\n' })
    expect(r).toEqual({ ok: true, value: VALID })
  })
})

describe('normalizeCAPostalCode', () => {
  it('answers the spaced capital form, or null', () => {
    expect(normalizeCAPostalCode('v9z9z9')).toBe('V9Z 9Z9')
    expect(normalizeCAPostalCode('V9Z 9Z9')).toBe('V9Z 9Z9')
    expect(normalizeCAPostalCode('V9Z9Z')).toBeNull()
    expect(normalizeCAPostalCode(null)).toBeNull()
    expect(normalizeCAPostalCode(undefined)).toBeNull()
  })
})

describe('the delivery-address door knows Canada', () => {
  it('sanitizes a Canadian address into the state and zip columns', () => {
    expect(sanitizeDeliveryAddress('CA', { street: '12 Invented Road', city: 'Faketown', state: 'bc', zip: 'v9z9z9' })).toEqual({
      ok: true,
      value: { street: '12 Invented Road', city: 'Faketown', state: 'BC', zip: 'V9Z 9Z9' },
    })
    expect(sanitizeDeliveryAddress('CA', { street: '12 Invented Road', city: 'Faketown', state: 'CA', zip: 'V9Z 9Z9' }).ok).toBe(false)
  })

  it('offers a province field, the 13 provinces, and calls the postcode a postal code', () => {
    expect(hasStateField('CA')).toBe(true)
    expect(stateLabel('CA')).toBe('Province')
    expect(stateOptionsFor('CA')).toBe(CA_PROVINCES)
    expect(postcodeLabel('CA')).toBe('Postal code')
    // The placeholder is the format itself, and it has to be a valid one.
    expect(normalizeCAPostalCode(postcodeExample('CA'))).toBe(postcodeExample('CA'))
    expect(deliveryCountriesFor('CA')).toBe(CA_DELIVERY_COUNTRIES)
    expect(CA_DELIVERY_COUNTRIES).toEqual([{ value: 'CA', label: 'Canada' }])
  })

  it('says under the field what is wrong with a typed postal code, and nothing while it is empty', () => {
    expect(postcodeProblem('CA', '')).toBeNull()
    expect(postcodeProblem('CA', 'm9x 9z9')).toBeNull()
    expect(postcodeProblem('CA', 'M9X 9O9')).toBe('Postal code must be in the form A1A 1A1.')
    expect(postcodeProblem('CA', '20794')).toBe('Postal code must be in the form A1A 1A1.')
  })

  it('lets the dialog submit a Canadian acceptance exactly when the server will take it', () => {
    const base = { winProbability: '50%', isCollection: false, hasAssociatedCompany: true }
    expect(acceptanceComplete('CA', { ...base, delivery: { street: '12 Invented Road', city: 'Faketown', state: 'ON', zip: 'M9X 9Z9' } })).toBe(true)
    expect(acceptanceComplete('CA', { ...base, delivery: { street: '12 Invented Road', city: 'Faketown', state: 'CA', zip: 'M9X 9Z9' } })).toBe(false)
    expect(acceptanceComplete('CA', { ...base, delivery: { street: '12 Invented Road', city: 'Faketown', state: 'ON', zip: '20794' } })).toBe(false)
    expect(acceptanceComplete('CA', { ...base, winProbability: '', delivery: { street: 'x', city: 'y', state: 'ON', zip: 'M9X 9Z9' } })).toBe(false)
    // Will Call: no address, as for the USA.
    expect(acceptanceComplete('CA', { ...base, isCollection: true, delivery: {} })).toBe(true)
  })

  it('leaves the USA and France exactly as they were', () => {
    expect(hasStateField('US')).toBe(true)
    expect(hasStateField('FR')).toBe(false)
    expect(stateLabel('US')).toBe('State')
    expect(stateOptionsFor('FR')).toEqual([])
    expect(postcodeLabel('US')).toBe('Zip')
    expect(postcodeLabel('FR')).toBe('Postcode')
    expect(postcodeExample('US')).toBe('20794')
    expect(postcodeExample('FR')).toBe('75008')
    expect(deliveryCountriesFor('US')).toEqual([{ value: 'US', label: 'USA' }])
    expect(deliveryCountriesFor('FR')).toEqual([{ value: 'FR', label: 'France' }])
    // The dialog's two messages, word for word.
    expect(postcodeProblem('US', '2079')).toBe('Zip must be 5 digits (or ZIP+4, e.g. 20794-1234).')
    expect(postcodeProblem('US', ' 20794-1234 ')).toBeNull()
    expect(postcodeProblem('FR', '7500')).toBe('Postcode must be 5 digits (e.g. 75008).')
    expect(postcodeProblem('FR', '75008')).toBeNull()
  })
})

describe('the database refuses exactly what the module refuses', () => {
  const sql = readFileSync(
    join(process.cwd(), 'supabase/migrations/20260924230000_a_canadian_customer_invoice_can_exist.sql'),
    'utf8',
  )

  it('carries the same postal pattern and the same 13 codes', () => {
    expect(sql).toContain(`delivery_zip ~ '${CA_POSTAL_CODE_PATTERN}'`)
    const branch = /when 'CA' then delivery_state is null or delivery_state = any \(array\[([^\]]+)\]\)/.exec(sql)
    expect(branch).not.toBeNull()
    const codes = branch![1].split(',').map((c) => c.trim().replace(/'/g, ''))
    expect([...codes].sort()).toEqual([...CA_PROVINCE_CODES].sort())
  })

  it('every postal code the module stores matches the stored pattern, and nothing unspaced does', () => {
    const stored = new RegExp(CA_POSTAL_CODE_PATTERN)
    for (const typed of ['m9x9z9', 'k9z 9y9', 'T9Z9Y9', 'y9z 9z9']) {
      const value = normalizeCAPostalCode(typed)
      expect(value, typed).not.toBeNull()
      expect(stored.test(value!), typed).toBe(true)
    }
    expect(stored.test('M9X9Z9')).toBe(false)
    expect(stored.test('m9x 9z9')).toBe(false)
  })
})
