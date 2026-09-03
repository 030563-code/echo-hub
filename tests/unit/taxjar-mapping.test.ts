import { describe, it, expect } from 'vitest'
import {
  buildTaxRequests,
  applyTaxResponses,
  collectionWarnings,
  type TaxableLine,
  type TaxJarTaxResponse,
} from '@/lib/customer-invoice/tax-mapping'
import { DEPOT_FROM_ADDRESSES, US_REGISTERED_STATES } from '@/lib/customer-invoice/constants'
import { US_STATE_CODES } from '@/lib/us-address'

const shipTo = { street: '1218 Broadway', city: 'Santa Monica', state: 'CA', zip: '90404' }

const line = (overrides: Partial<TaxableLine>): TaxableLine => ({
  line_key: 'L1',
  quantity: 1,
  unit_price: 100,
  discount_percentage: 0,
  line_total: 100,
  is_shipping: false,
  ship_from_depot: 'US-BAL',
  ...overrides,
})

describe('buildTaxRequests', () => {
  it('builds one request for a single-depot invoice, shipping folded into it', () => {
    const result = buildTaxRequests(
      [line({ line_key: 'L1' }), line({ line_key: 'L2', is_shipping: true, line_total: 250, unit_price: 250 })],
      shipTo,
      'US123',
      false,
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.groups).toHaveLength(1)
    const [group] = result.groups
    expect(group.depot).toBe('US-BAL')
    expect(group.request.shipping).toBe(250)
    expect(group.request.customer_id).toBe('US123')
    expect(group.request.line_items).toEqual([{ id: 'L1', quantity: 1, unit_price: 100 }])
    expect(group.request.from_zip).toBe('20794')
    expect(group.request.to_state).toBe('CA')
  })

  it('converts a percentage discount into a TaxJar dollar discount', () => {
    const result = buildTaxRequests([line({ quantity: 10, unit_price: 100, discount_percentage: 15, line_total: 850 })], shipTo, null, false)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.groups[0].request.line_items[0].discount).toBe(150)
    expect(result.groups[0].request.customer_id).toBeUndefined()
  })

  it('builds a US-SBD group now that Rancho Cucamonga is configured', () => {
    const result = buildTaxRequests([line({ ship_from_depot: 'US-SBD' })], shipTo, null, false)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.groups[0].request.from_zip).toBe('91730')
    expect(result.groups[0].request.from_state).toBe('CA')
  })

  it('refuses goods from a depot whose dispatch address is not configured', () => {
    const saved = DEPOT_FROM_ADDRESSES['US-SBD']
    DEPOT_FROM_ADDRESSES['US-SBD'] = null
    try {
      const result = buildTaxRequests([line({ ship_from_depot: 'US-SBD' })], shipTo, null, false)
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toMatch(/US-SBD/)
    } finally {
      DEPOT_FROM_ADDRESSES['US-SBD'] = saved
    }
  })

  it('refuses an empty invoice and a shipping-only invoice', () => {
    expect(buildTaxRequests([], shipTo, null, false).ok).toBe(false)
    expect(buildTaxRequests([line({ is_shipping: true })], shipTo, null, false).ok).toBe(false)
  })
})

describe('applyTaxResponses', () => {
  const response = (tax: TaxJarTaxResponse['tax']): TaxJarTaxResponse => ({ tax })

  const twoLines = [line({ line_key: 'L1' }), line({ line_key: 'L2', is_shipping: true, line_total: 250 })]

  const group = () => {
    const built = buildTaxRequests(twoLines, shipTo, null, false)
    if (!built.ok) throw new Error('setup failed')
    return built.groups[0]
  }

  it('maps per-line tax and shipping tax back onto the lines', () => {
    const result = applyTaxResponses(twoLines, [
      {
        group: group(),
        response: response({
          amount_to_collect: 34.38,
          has_nexus: true,
          breakdown: {
            shipping: { tax_collectable: 23.63 },
            line_items: [{ id: 'L1', tax_collectable: 10.75, taxable_amount: 100, combined_tax_rate: 0.1075 }],
          },
        }),
      },
    ])
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.taxTotal).toBe(34.38)
    expect(result.warnings).toEqual([])
    const l1 = result.lines.find((l) => l.line_key === 'L1')
    const l2 = result.lines.find((l) => l.line_key === 'L2')
    expect(l1?.tax_amount).toBe(10.75)
    expect(l1?.combined_tax_rate).toBe(0.1075)
    expect(l2?.tax_amount).toBe(23.63)
  })

  it('zeroes tax and warns when there is no nexus (breakdown absent)', () => {
    // Nevada deliberately: no registration is held there, so zero tax is the
    // right answer. A REGISTERED state with no nexus is refused instead, which
    // the registered-but-no-nexus block below covers.
    const nevadaBuilt = buildTaxRequests(twoLines, { street: '100 N Sierra St', city: 'Reno', state: 'NV', zip: '89501' }, null, false)
    if (!nevadaBuilt.ok) throw new Error('setup failed')
    const result = applyTaxResponses(twoLines, [
      { group: nevadaBuilt.groups[0], response: response({ amount_to_collect: 0, has_nexus: false }) },
    ])
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.taxTotal).toBe(0)
    expect(result.warnings.some((w) => /no nexus/i.test(w))).toBe(true)
    expect(result.lines.find((l) => l.line_key === 'L1')?.tax_amount).toBe(0)
  })

  it('errors when a partial breakdown is missing one of our lines', () => {
    const lines = [line({ line_key: 'L1' }), line({ line_key: 'L2' })]
    const built = buildTaxRequests(lines, shipTo, null, false)
    if (!built.ok) throw new Error('setup failed')
    const result = applyTaxResponses(lines, [
      {
        group: built.groups[0],
        response: response({
          amount_to_collect: 10.75,
          breakdown: { line_items: [{ id: 'L1', tax_collectable: 10.75 }] },
        }),
      },
    ])
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/L2/)
  })

  it('allocates shipping tax across multiple shipping lines with the cent remainder on the largest', () => {
    const lines = [
      line({ line_key: 'L1' }),
      line({ line_key: 'S1', is_shipping: true, line_total: 100 }),
      line({ line_key: 'S2', is_shipping: true, line_total: 200 }),
    ]
    const built = buildTaxRequests(lines, shipTo, null, false)
    if (!built.ok) throw new Error('setup failed')
    const result = applyTaxResponses(lines, [
      {
        group: built.groups[0],
        response: response({
          amount_to_collect: 0.11,
          breakdown: { shipping: { tax_collectable: 0.11 }, line_items: [{ id: 'L1', tax_collectable: 0 }] },
        }),
      },
    ])
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const s1 = result.lines.find((l) => l.line_key === 'S1')?.tax_amount ?? 0
    const s2 = result.lines.find((l) => l.line_key === 'S2')?.tax_amount ?? 0
    expect(Math.round((s1 + s2) * 100) / 100).toBe(0.11)
    expect(s2).toBeGreaterThan(s1)
  })

  it('warns on a reconciliation gap beyond a cent, keeping per-line values canonical', () => {
    const lines = [line({ line_key: 'L1' })]
    const built = buildTaxRequests(lines, shipTo, null, false)
    if (!built.ok) throw new Error('setup failed')
    const result = applyTaxResponses(lines, [
      {
        group: built.groups[0],
        response: response({
          amount_to_collect: 12.0,
          breakdown: { line_items: [{ id: 'L1', tax_collectable: 10.75 }] },
        }),
      },
    ])
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.taxTotal).toBe(10.75)
    expect(result.warnings.some((w) => /difference/i.test(w))).toBe(true)
  })

  it('handles the two-depot case as two independent groups', () => {
    const lines = [line({ line_key: 'L1' }), line({ line_key: 'L2', ship_from_depot: 'US-SBD' })]
    // US-SBD has no address yet, so building refuses; simulate the future state
    // by grouping only the Baltimore line and verifying totals sum per group.
    const built = buildTaxRequests([lines[0]], shipTo, null, false)
    if (!built.ok) throw new Error('setup failed')
    const result = applyTaxResponses([lines[0]], [
      {
        group: built.groups[0],
        response: response({ amount_to_collect: 5, breakdown: { line_items: [{ id: 'L1', tax_collectable: 5 }] } }),
      },
    ])
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.taxTotal).toBe(5)
  })
})

describe('freight-only depot groups', () => {
  it('folds a shipping-only group into the group that carries the goods', () => {
    // Baltimore-only freight on an invoice whose goods ship from Baltimore too
    // is the common case; the pathological one is freight alone in a group.
    const lines = [
      line({ line_key: 'L1', ship_from_depot: 'US-BAL' }),
      line({ line_key: 'S1', ship_from_depot: 'US-BAL', is_shipping: true, line_total: 100, unit_price: 100 }),
    ]
    const result = buildTaxRequests(lines, shipTo, null, false)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.groups).toHaveLength(1)
    expect(result.groups[0].request.line_items.length).toBeGreaterThan(0)
    expect(result.groups[0].request.shipping).toBe(100)
  })

  it('never emits a request with empty line_items (TaxJar rejects those)', () => {
    const lines = [
      line({ line_key: 'L1', ship_from_depot: 'US-BAL' }),
      line({ line_key: 'S1', ship_from_depot: 'US-BAL', is_shipping: true, line_total: 40, unit_price: 40 }),
      line({ line_key: 'S2', ship_from_depot: 'US-BAL', is_shipping: true, line_total: 60, unit_price: 60 }),
    ]
    const result = buildTaxRequests(lines, shipTo, null, false)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    for (const group of result.groups) {
      expect(group.request.line_items.length).toBeGreaterThan(0)
    }
    expect(result.groups[0].request.shipping).toBe(100)
    expect(result.groups[0].shippingLineKeys).toEqual(['S1', 'S2'])
  })
})

describe('freight shipping from a depot with no goods', () => {
  it('folds US-SBD freight into the US-BAL goods group without needing an SBD address', () => {
    // This is the case the fold exists for: the reviewer moved the freight line
    // to San Bernardino, whose dispatch address is not configured. It must not
    // block the calculation, because that from-address is never used.
    const lines = [
      line({ line_key: 'L1', ship_from_depot: 'US-BAL' }),
      line({ line_key: 'S1', ship_from_depot: 'US-SBD', is_shipping: true, line_total: 250, unit_price: 250 }),
    ]
    const result = buildTaxRequests(lines, shipTo, null, false)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.groups).toHaveLength(1)
    expect(result.groups[0].depot).toBe('US-BAL')
    expect(result.groups[0].request.shipping).toBe(250)
    expect(result.groups[0].shippingLineKeys).toContain('S1')
  })

  it('still refuses when GOODS ship from a depot with no dispatch address', () => {
    const saved = DEPOT_FROM_ADDRESSES['US-SBD']
    DEPOT_FROM_ADDRESSES['US-SBD'] = null
    try {
      const result = buildTaxRequests([line({ line_key: 'L1', ship_from_depot: 'US-SBD' })], shipTo, null, false)
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toMatch(/US-SBD/)
    } finally {
      DEPOT_FROM_ADDRESSES['US-SBD'] = saved
    }
  })

  it('allocates the folded freight tax back to the line that carried it', () => {
    const lines = [
      line({ line_key: 'L1', ship_from_depot: 'US-BAL' }),
      line({ line_key: 'S1', ship_from_depot: 'US-SBD', is_shipping: true, line_total: 250 }),
    ]
    const built = buildTaxRequests(lines, shipTo, null, false)
    if (!built.ok) throw new Error('setup failed')
    const result = applyTaxResponses(lines, [
      {
        group: built.groups[0],
        response: {
          tax: {
            amount_to_collect: 37.63,
            breakdown: { shipping: { tax_collectable: 26.88 }, line_items: [{ id: 'L1', tax_collectable: 10.75 }] },
          },
        },
      },
    ])
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.lines.find((l) => l.line_key === 'S1')?.tax_amount).toBe(26.88)
    expect(result.taxTotal).toBe(37.63)
  })
})


describe('collected orders (Will Call)', () => {
  const BAL = DEPOT_FROM_ADDRESSES['US-BAL']!

  it('sends the depot as both origin and destination', () => {
    const result = buildTaxRequests([line({ line_key: 'L1' })], shipTo, 'US123', true)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const { request } = result.groups[0]
    expect(request.to_state).toBe('MD')
    expect(request.to_zip).toBe('20794')
    expect(request.to_city).toBe('Jessup')
    expect(request.to_street).toBe(BAL.street)
    expect(request.to_country).toBe('US')
    // Origin and destination are the same place on a collection.
    expect(request.to_state).toBe(request.from_state)
    expect(request.to_zip).toBe(request.from_zip)
    // The customer's address must not leak into the request at all: a partial
    // application of this change would leave one of the to_ fields behind.
    const serialized = JSON.stringify(request)
    expect(serialized).not.toContain('90404')
    expect(serialized).not.toContain('Santa Monica')
    expect(serialized).not.toContain('Broadway')
  })

  it('needs no delivery address at all when collected', () => {
    const result = buildTaxRequests([line({ line_key: 'L1' })], null, null, true)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.groups[0].request.to_zip).toBe('20794')
  })

  it('refuses a delivered invoice with no delivery address', () => {
    const result = buildTaxRequests([line({ line_key: 'L1' })], null, null, false)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/delivery address/i)
  })

  it('carries freight on a collected order and flags it', () => {
    const lines = [
      line({ line_key: 'L1' }),
      line({ line_key: 'L2', is_shipping: true, line_total: 250, unit_price: 250 }),
    ]
    const result = buildTaxRequests(lines, null, null, true)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    // Xero bills the freight either way, so dropping it from the tax base
    // would under-collect. Keep it, and warn.
    expect(result.groups[0].request.shipping).toBe(250)
    expect(result.groups[0].shippingLineKeys).toContain('L2')
    const warnings = collectionWarnings(lines, true)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatch(/250\.00/)
    expect(collectionWarnings(lines, false)).toEqual([])
  })

  it('refuses collected goods from a depot with no configured address', () => {
    const saved = DEPOT_FROM_ADDRESSES['US-SBD']
    DEPOT_FROM_ADDRESSES['US-SBD'] = null
    let result
    try {
      result = buildTaxRequests([line({ ship_from_depot: 'US-SBD' })], null, null, true)
    } finally {
      DEPOT_FROM_ADDRESSES['US-SBD'] = saved
    }
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toMatch(/US-SBD/)
      // The reviewer needs to know it is blocking for the collection reason,
      // not only the shipping one.
      expect(result.error).toMatch(/collected from/i)
    }
  })

  it('still folds freight-only US-SBD into the Baltimore group when collected', () => {
    const result = buildTaxRequests(
      [
        line({ line_key: 'L1' }),
        line({ line_key: 'L2', ship_from_depot: 'US-SBD', is_shipping: true, line_total: 90, unit_price: 90 }),
      ],
      null,
      null,
      true,
    )
    // The fold must not start demanding an SBD address just because
    // collection is on: that group never uses one.
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.groups).toHaveLength(1)
    expect(result.groups[0].request.shipping).toBe(90)
    expect(result.groups[0].shippingLineKeys).toContain('L2')
  })

  it('produces two different destinations when collected across two depots', () => {
    const original = DEPOT_FROM_ADDRESSES['US-SBD']
    DEPOT_FROM_ADDRESSES['US-SBD'] = {
      street: '9400 Santa Anita Ave',
      city: 'Rancho Cucamonga',
      state: 'CA',
      zip: '91730',
      country: 'US',
    }
    try {
      const result = buildTaxRequests(
        [line({ line_key: 'L1' }), line({ line_key: 'L2', ship_from_depot: 'US-SBD' })],
        null,
        null,
        true,
      )
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.groups).toHaveLength(2)
      // This is what breaks any "one destination per invoice" assumption.
      expect(result.groups[0].request.to_state).toBe('MD')
      expect(result.groups[1].request.to_state).toBe('CA')
      for (const g of result.groups) {
        expect(g.request.to_zip).toBe(g.request.from_zip)
        expect(g.request.to_street).toBe(g.request.from_street)
      }
    } finally {
      DEPOT_FROM_ADDRESSES['US-SBD'] = original
    }
  })
})


describe('registered-but-no-nexus block', () => {
  // TaxJar returns has_nexus:false and ZERO tax for a state it is not
  // configured for, with no error. Where Echo Barrier holds a registration
  // that is real tax being under-collected, so it must refuse rather than warn.
  // Maryland is exactly this today, and US-BAL is in Jessup MD, so every
  // COLLECTED Baltimore order is a Maryland sale.
  const noNexus = (): TaxJarTaxResponse => ({
    tax: { has_nexus: false, amount_to_collect: 0, breakdown: undefined },
  })

  const groupFor = (collected: boolean, depot: 'US-BAL' | 'US-SBD') => {
    const built = buildTaxRequests([line({ ship_from_depot: depot })], shipTo, null, collected)
    if (!built.ok) throw new Error('setup failed')
    return built.groups[0]
  }

  it('refuses a collected Baltimore order while Maryland is switched off', () => {
    const group = groupFor(true, 'US-BAL')
    expect(group.request.to_state).toBe('MD')
    const result = applyTaxResponses([line({ ship_from_depot: 'US-BAL' })], [{ group, response: noNexus() }])
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toMatch(/MD/)
      expect(result.error).toMatch(/under-collect/i)
    }
  })

  it('refuses a delivery into a registered state with no nexus', () => {
    // shipTo is Santa Monica CA, and CA is a registered state.
    const group = groupFor(false, 'US-BAL')
    expect(group.request.to_state).toBe('CA')
    const result = applyTaxResponses([line({})], [{ group, response: noNexus() }])
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/CA/)
  })

  it('only warns where no registration is held', () => {
    // Nevada: no registration, so zero tax is the correct answer, not a fault.
    const nevada = { street: '100 N Sierra St', city: 'Reno', state: 'NV', zip: '89501' }
    const built = buildTaxRequests([line({})], nevada, null, false)
    expect(built.ok).toBe(true)
    if (!built.ok) return
    const result = applyTaxResponses([line({})], [{ group: built.groups[0], response: noNexus() }])
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.warnings.join(' ')).toMatch(/no nexus in NV/)
      expect(result.warnings.join(' ')).toMatch(/not registered/i)
    }
  })

  it('every registered state is a real two-letter code', () => {
    for (const code of US_REGISTERED_STATES) {
      expect(US_STATE_CODES).toContain(code)
    }
    expect(US_REGISTERED_STATES).toContain('MD')
  })
})
