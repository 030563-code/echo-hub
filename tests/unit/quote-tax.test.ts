import { describe, it, expect } from 'vitest'
import { taxRegionForTemplate, TAX_NOTES } from '@/lib/quote-pdf'

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
