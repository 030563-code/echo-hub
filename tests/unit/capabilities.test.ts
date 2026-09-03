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

  it('carries the two pricing capabilities the Phase B migration seeds', () => {
    // The TS catalogue and the `capabilities` table have to stay in step: a key
    // in one and not the other is a grant that resolves to nothing, or a nav
    // item nobody can ever see.
    expect(CAPABILITY_KEYS).toContain('pricing.view')
    expect(CAPABILITY_KEYS).toContain('pricing.manage')
    expect(CAPABILITIES.find((c) => c.key === 'pricing.manage')?.module).toBe('pricing')
  })

  it('gives the Pricing module a nav entry a read-only rep can reach', () => {
    // Dean asked for "a sales tab on the nav bar for them to see live pricing
    // of everything that they can't change", so pricing.view alone must open it.
    const pricing = NAV_ITEMS.find((i) => i.href === '/pricing')
    expect(pricing?.requires).toEqual(['pricing.view', 'pricing.manage'])
    expect(satisfiesRequirement(new Set<CapabilityKey>(['pricing.view']), pricing?.requires ?? [])).toBe(true)
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
