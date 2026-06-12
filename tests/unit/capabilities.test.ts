import { describe, it, expect } from 'vitest'
import {
  CAPABILITIES,
  CAPABILITY_KEYS,
  NAV_ITEMS,
  satisfiesRequirement,
  type CapabilityKey,
} from '@/lib/capabilities'

describe('capability catalogue', () => {
  it('CAPABILITIES covers exactly the CAPABILITY_KEYS', () => {
    const catalogueKeys = CAPABILITIES.map((c) => c.key).sort()
    expect(catalogueKeys).toEqual([...CAPABILITY_KEYS].sort())
  })

  it('every NAV_ITEM requires only known capabilities', () => {
    const known = new Set<string>(CAPABILITY_KEYS)
    for (const item of NAV_ITEMS) {
      for (const req of item.requires) expect(known.has(req)).toBe(true)
    }
  })
})

describe('satisfiesRequirement', () => {
  const caps = (...keys: CapabilityKey[]) => new Set<CapabilityKey>(keys)

  it('admin satisfies any requirement', () => {
    expect(satisfiesRequirement(caps('admin'), ['po.approve'])).toBe(true)
    expect(satisfiesRequirement(caps('admin'), ['quotes.view', 'quotes.create'])).toBe(true)
  })

  it('empty requirement is always satisfied (e.g. Dashboard)', () => {
    expect(satisfiesRequirement(caps(), [])).toBe(true)
  })

  it('matches when the user holds at least one required capability', () => {
    expect(satisfiesRequirement(caps('quotes.view'), ['quotes.view', 'quotes.create'])).toBe(true)
  })

  it('denies when the user holds none of the required capabilities', () => {
    // Jillian: quotes + po.create, but NOT po.approve — cannot satisfy an approve-only gate.
    expect(satisfiesRequirement(caps('quotes.view', 'quotes.create', 'po.create'), ['po.approve'])).toBe(false)
  })
})
