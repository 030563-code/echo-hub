import { describe, it, expect } from 'vitest'
import {
  CAPABILITIES,
  CAPABILITY_KEYS,
  NAV_GROUPS,
  NAV_ITEMS,
  navSections,
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

describe('navSections', () => {
  const caps = (...keys: CapabilityKey[]) => new Set<CapabilityKey>(keys)

  it('puts the ungrouped items first, then the groups in order', () => {
    const sections = navSections(caps('admin'))
    expect(sections.map((s) => s.group)).toEqual([null, ...NAV_GROUPS])
    expect(sections[0].items.map((i) => i.label)).toEqual(['Dashboard'])
  })

  it('groups the modules the way Dean asked', () => {
    const byGroup = Object.fromEntries(
      navSections(caps('admin')).map((s) => [s.group ?? 'top', s.items.map((i) => i.label)]),
    )
    expect(byGroup['Sales and Accounting']).toEqual(['Quotes', 'Invoicing', 'Pricing'])
    expect(byGroup['Operations']).toEqual(['Purchase Orders', 'Bill of Materials', 'Transport', 'MRP'])
  })

  it('drops a group entirely when every item in it is gated away', () => {
    // Jillian's real capabilities. She must not be shown an "Operations"
    // heading with nothing under it, or one she cannot open anything in.
    const sections = navSections(caps('quotes.view', 'quotes.create', 'pricing.view'))
    expect(sections.map((s) => s.group)).toEqual([null, 'Sales and Accounting'])
    expect(sections[1].items.map((i) => i.label)).toEqual(['Quotes', 'Pricing'])
  })

  it('never returns an empty section', () => {
    for (const set of [caps(), caps('admin'), caps('bom.view'), caps('quotes.view')]) {
      for (const section of navSections(set)) {
        expect(section.items.length).toBeGreaterThan(0)
      }
    }
  })

  it('gives every module a group, so nothing strays above the headings', () => {
    // Dashboard is the deliberate exception: it is the only top-level entry.
    const ungrouped = NAV_ITEMS.filter((i) => !i.group).map((i) => i.href)
    expect(ungrouped).toEqual(['/'])
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
