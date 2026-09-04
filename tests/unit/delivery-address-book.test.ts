import { describe, it, expect } from 'vitest'
import {
  deliveryContactKey,
  deliveryAddressFingerprint,
  isSaveableDeliveryAddress,
  deliveryAddressLabel,
  deliveryAddressLines,
  requestedByLine,
} from '@/lib/customer-invoice/delivery-address-book'

describe('deliveryContactKey', () => {
  it('prefers the Xero account code, which is what Dean asked it to be keyed on', () => {
    expect(deliveryContactKey('UR-001', '123')).toBe('xero:UR-001')
  })

  // usa_xero_account_code is nullable, so without this fallback every uncoded
  // customer would share one book.
  it('falls back to the HubSpot company id when there is no Xero code', () => {
    expect(deliveryContactKey(null, '123')).toBe('hs:123')
    expect(deliveryContactKey('   ', '123')).toBe('hs:123')
  })

  it('returns null when neither exists, so no book is better than a shared one', () => {
    expect(deliveryContactKey(null, null)).toBeNull()
    expect(deliveryContactKey('', '  ')).toBeNull()
  })
})

describe('deliveryAddressFingerprint', () => {
  const base = { street: '12 Main St', city: 'Baltimore', state: 'MD', zip: '21201', country: 'US' }

  it('treats the same address typed differently as one address', () => {
    expect(deliveryAddressFingerprint({ ...base, street: '12  MAIN  st ' }))
      .toBe(deliveryAddressFingerprint(base))
  })

  it('keeps two depots at one street apart, which is the whole rental-firm case', () => {
    const g52 = deliveryAddressFingerprint({ ...base, location: 'Location G52' })
    const g92 = deliveryAddressFingerprint({ ...base, location: 'Location G92' })
    expect(g52).not.toBe(g92)
  })

  // Otherwise the dropdown grows by one entry per person who ever ordered.
  it('ignores who requested it: one address, not one per requester', () => {
    expect(deliveryAddressFingerprint({ ...base, requestedBy: 'Dan Buckley' }))
      .toBe(deliveryAddressFingerprint({ ...base, requestedBy: 'Someone Else' }))
  })

  it('defaults a missing country to US rather than to blank', () => {
    expect(deliveryAddressFingerprint({ ...base, country: null }))
      .toBe(deliveryAddressFingerprint(base))
  })
})

describe('isSaveableDeliveryAddress', () => {
  it('accepts an address that carries the four fields tax needs', () => {
    expect(isSaveableDeliveryAddress({ street: '12 Main St', city: 'Baltimore', state: 'MD', zip: '21201' })).toBe(true)
  })

  // A half-typed address saved by accident sits in the dropdown forever.
  it('refuses a partial address', () => {
    expect(isSaveableDeliveryAddress({ street: '12 Main St', city: '', state: 'MD', zip: '21201' })).toBe(false)
    expect(isSaveableDeliveryAddress({ street: '  ', city: 'Baltimore', state: 'MD', zip: '21201' })).toBe(false)
    expect(isSaveableDeliveryAddress({})).toBe(false)
  })
})

describe('deliveryAddressLabel', () => {
  it('leads with the location, because that is what the rep is looking for', () => {
    expect(deliveryAddressLabel({ street: '12 Main St', city: 'Baltimore', state: 'MD', zip: '21201', location: 'Location G52' }))
      .toBe('Location G52 — 12 Main St, Baltimore, MD 21201')
  })

  it('reads cleanly with no location', () => {
    expect(deliveryAddressLabel({ street: '12 Main St', city: 'Baltimore', state: 'MD', zip: '21201' }))
      .toBe('12 Main St, Baltimore, MD 21201')
  })
})

describe('deliveryAddressLines and requestedByLine', () => {
  it('puts the location under the street', () => {
    expect(deliveryAddressLines({ street: '12 Main St', location: 'Location G52', city: 'Baltimore', state: 'MD', zip: '21201' }))
      .toEqual(['12 Main St', 'Location G52', 'Baltimore, MD 21201'])
  })

  // An invoice with neither optional field must print exactly what it printed
  // before this feature existed.
  it('prints nothing extra when neither optional field is set', () => {
    expect(deliveryAddressLines({ street: '12 Main St', city: 'Baltimore', state: 'MD', zip: '21201' }))
      .toEqual(['12 Main St', 'Baltimore, MD 21201'])
    expect(requestedByLine(null)).toBeNull()
    expect(requestedByLine('   ')).toBeNull()
  })

  it('names the requester when there is one', () => {
    expect(requestedByLine('Dan Buckley')).toBe('Requested by: Dan Buckley')
  })
})
