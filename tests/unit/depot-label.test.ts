import { describe, it, expect } from 'vitest'
import { DEPOT_MAPPING, depotLabel } from '@/lib/depot-constants'

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
