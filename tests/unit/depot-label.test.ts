import { describe, it, expect } from 'vitest'
import { DEPOT_MAPPING, depotLabel, depotCode, depotQueryValues } from '@/lib/depot-constants'

describe('depotLabel', () => {
  it('maps every known code to its friendly name', () => {
    expect(depotLabel('US-BAL')).toBe('US Baltimore')
    expect(depotLabel('US-SBD')).toBe('US California')
    expect(depotLabel('CA-HAM')).toBe('CA - Hamilton')
    for (const code of Object.keys(DEPOT_MAPPING)) {
      expect(depotLabel(code)).toBe(DEPOT_MAPPING[code])
    }
  })

  it('passes an unknown code through rather than hiding it', () => {
    // A code the rep recognises beats the word "Unknown".
    expect(depotLabel('XX-NEW')).toBe('XX-NEW')
  })

  it('returns the fallback for blank input, and never throws', () => {
    expect(depotLabel(null)).toBe('—')
    expect(depotLabel(undefined)).toBe('—')
    expect(depotLabel('')).toBe('—')
    expect(depotLabel('   ')).toBe('—')
    expect(depotLabel(null, 'Decided at acceptance')).toBe('Decided at acceptance')
  })

  it('trims surrounding whitespace before looking up', () => {
    expect(depotLabel('  US-BAL  ')).toBe('US Baltimore')
  })
})

/**
 * HubSpot's sending_depot stores the long name ('EU-France') as its internal
 * value and shows the code ('EU-FR') as its label, and the EURO deal sync
 * copies the value into deals_registry. So a depot read off a record can be
 * spelled either way, and depotCode is the one reader of both.
 */
describe('depotCode reads a depot back from whichever spelling a record holds', () => {
  it("accepts the code, and HubSpot's internal value for it, in any case", () => {
    expect(depotCode('EU-FR')).toBe('EU-FR')
    expect(depotCode('EU-France')).toBe('EU-FR')
    expect(depotCode('eu-france')).toBe('EU-FR')
    expect(depotCode('US Baltimore')).toBe('US-BAL')
    expect(depotCode('  CA - Hamilton ')).toBe('CA-HAM')
    for (const [code, value] of Object.entries(DEPOT_MAPPING)) {
      expect(depotCode(code)).toBe(code)
      expect(depotCode(value)).toBe(code)
    }
  })

  it('answers null for anything else, never a guess', () => {
    expect(depotCode('XX-NEW')).toBeNull()
    expect(depotCode('France')).toBeNull()
    expect(depotCode('')).toBeNull()
    expect(depotCode('   ')).toBeNull()
    expect(depotCode(null)).toBeNull()
    expect(depotCode(undefined)).toBeNull()
  })
})

describe('depotQueryValues lists every spelling the deals registry may hold', () => {
  it("pairs each code with HubSpot's value, without repeats", () => {
    expect(depotQueryValues(['EU-FR'])).toEqual(['EU-FR', 'EU-France'])
    expect(depotQueryValues(['US-BAL', 'US-SBD'])).toEqual(['US-BAL', 'US Baltimore', 'US-SBD', 'US California'])
    expect(depotQueryValues([])).toEqual([])
  })

  it('passes an unmapped code through alone', () => {
    expect(depotQueryValues(['XX-NEW'])).toEqual(['XX-NEW'])
  })
})
