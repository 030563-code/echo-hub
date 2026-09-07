import { describe, it, expect } from 'vitest'
import { COUNTRIES, countryCode, countryName } from '@/lib/countries'

describe('the country list', () => {
  it('is the full ISO 3166-1 alpha-2 set', () => {
    expect(COUNTRIES).toHaveLength(249)
  })

  it('has no duplicate codes or names', () => {
    expect(new Set(COUNTRIES.map((c) => c.code)).size).toBe(COUNTRIES.length)
    expect(new Set(COUNTRIES.map((c) => c.name)).size).toBe(COUNTRIES.length)
  })

  it('uses two uppercase letters for every code', () => {
    for (const c of COUNTRIES) expect(c.code, c.name).toMatch(/^[A-Z]{2}$/)
  })

  it('is sorted by name, so a picker needs no sorting of its own', () => {
    const sorted = [...COUNTRIES].sort((a, b) => a.name.localeCompare(b.name, 'en'))
    expect(COUNTRIES.map((c) => c.name)).toEqual(sorted.map((c) => c.name))
  })

  it('keeps US reading as USA', () => {
    // The invoice document prints this string and the Xero contacts hold it.
    // Renaming it to "United States" would rewrite them on the next save.
    expect(countryName('US')).toBe('USA')
    expect(COUNTRIES.find((c) => c.code === 'US')?.name).toBe('USA')
  })

  it('carries the countries this business actually ships to', () => {
    for (const code of ['CA', 'GB', 'SK', 'FR', 'AU', 'JP', 'ZA']) {
      expect(COUNTRIES.some((c) => c.code === code), code).toBe(true)
    }
  })

  it('reads a code back from a name or a code, and says so when it cannot', () => {
    expect(countryCode('Canada')).toBe('CA')
    expect(countryCode('canada')).toBe('CA')
    expect(countryCode('CA')).toBe('CA')
    expect(countryCode('USA')).toBe('US')
    expect(countryCode('Narnia')).toBeNull()
    expect(countryCode('')).toBeNull()
    expect(countryCode(null)).toBeNull()
  })

  it('gives an unknown code back rather than an empty string', () => {
    expect(countryName('XX')).toBe('XX')
    expect(countryName(null)).toBe('')
  })
})
