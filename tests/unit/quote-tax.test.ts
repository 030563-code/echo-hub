import { describe, it, expect } from 'vitest'
import {
  taxRegionForTemplate,
  TAX_NOTES,
  entityAddressForRegion,
  DEFAULT_ENTITY_ADDRESS,
} from '@/lib/quote-pdf'

describe('taxRegionForTemplate (quote template drives the tax wording)', () => {
  it('maps the two real template values', () => {
    expect(taxRegionForTemplate('US')).toBe('US')
    expect(taxRegionForTemplate('CAN')).toBe('CAN')
  })

  it('is tolerant of casing and stray whitespace from the profile array', () => {
    expect(taxRegionForTemplate(' us ')).toBe('US')
    expect(taxRegionForTemplate('can')).toBe('CAN')
  })

  it('returns undefined for anything unrecognised, so no tax line is printed', () => {
    // allowed_quote_templates is free text in the database. Guessing a
    // jurisdiction would put a wrong commercial statement on a customer
    // document, so an unknown template prints nothing at all.
    expect(taxRegionForTemplate('EU')).toBeUndefined()
    expect(taxRegionForTemplate('CA')).toBeUndefined()
    expect(taxRegionForTemplate('')).toBeUndefined()
    expect(taxRegionForTemplate(null)).toBeUndefined()
    expect(taxRegionForTemplate(undefined)).toBeUndefined()
  })

  it('carries Dean-supplied wording verbatim', () => {
    expect(TAX_NOTES.US).toBe('Federal and state tax will be applied on invoicing where applicable.')
    expect(TAX_NOTES.CAN).toBe('All taxes will be applied on invoicing.')
  })
})

describe('entityAddressForRegion (issuing entity follows the template)', () => {
  it('gives a US quote the Chicago LLC, not the Dublin group', () => {
    const us = entityAddressForRegion('US')
    expect(us).toContain('Echo Barrier USA LLC')
    expect(us).toContain('Chicago')
    expect(us).toContain('IL 60602')
    expect(us.join(' ')).not.toContain('Dublin')
  })

  it('gives a Canadian quote the Toronto address', () => {
    const can = entityAddressForRegion('CAN')
    expect(can).toContain('2482 Yonge Street')
    expect(can).toContain('Ontario M4P 2H5')
    expect(can.join(' ')).not.toContain('Dublin')
  })

  it('falls back to the group entity when the template is unrecognised', () => {
    // Same behaviour every quote had before the split, so an odd template
    // value degrades to the parent entity rather than to no address at all.
    expect(entityAddressForRegion(undefined)).toEqual(DEFAULT_ENTITY_ADDRESS)
    expect(DEFAULT_ENTITY_ADDRESS).toContain('Echo Barrier Group')
  })

  it('carries the same head-office number on both', () => {
    expect(entityAddressForRegion('US')).toContain('Tel: + 1 (800) 728 9098')
    expect(entityAddressForRegion('CAN')).toContain('Tel: + 1 (800) 728 9098')
  })
})
