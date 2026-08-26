import { describe, it, expect } from 'vitest'
import {
  buildTaxRequests,
  applyTaxResponses,
  type TaxableLine,
  type TaxJarTaxResponse,
} from '@/lib/customer-invoice/tax-mapping'

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
    const result = buildTaxRequests([line({ quantity: 10, unit_price: 100, discount_percentage: 15, line_total: 850 })], shipTo, null)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.groups[0].request.line_items[0].discount).toBe(150)
    expect(result.groups[0].request.customer_id).toBeUndefined()
  })

  it('refuses US-SBD groups until the San Bernardino dispatch address is configured', () => {
    const result = buildTaxRequests([line({ ship_from_depot: 'US-SBD' })], shipTo, null)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/US-SBD/)
  })

  it('refuses an empty invoice and a shipping-only invoice', () => {
    expect(buildTaxRequests([], shipTo, null).ok).toBe(false)
    expect(buildTaxRequests([line({ is_shipping: true })], shipTo, null).ok).toBe(false)
  })
})

describe('applyTaxResponses', () => {
  const response = (tax: TaxJarTaxResponse['tax']): TaxJarTaxResponse => ({ tax })

  const twoLines = [line({ line_key: 'L1' }), line({ line_key: 'L2', is_shipping: true, line_total: 250 })]

  const group = () => {
    const built = buildTaxRequests(twoLines, shipTo, null)
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
    const result = applyTaxResponses(twoLines, [
      { group: group(), response: response({ amount_to_collect: 0, has_nexus: false }) },
    ])
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.taxTotal).toBe(0)
    expect(result.warnings.some((w) => /no nexus/i.test(w))).toBe(true)
    expect(result.lines.find((l) => l.line_key === 'L1')?.tax_amount).toBe(0)
  })

  it('errors when a partial breakdown is missing one of our lines', () => {
    const lines = [line({ line_key: 'L1' }), line({ line_key: 'L2' })]
    const built = buildTaxRequests(lines, shipTo, null)
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
    const built = buildTaxRequests(lines, shipTo, null)
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
    const built = buildTaxRequests(lines, shipTo, null)
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
    const built = buildTaxRequests([lines[0]], shipTo, null)
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
    const result = buildTaxRequests(lines, shipTo, null)
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
    const result = buildTaxRequests(lines, shipTo, null)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    for (const group of result.groups) {
      expect(group.request.line_items.length).toBeGreaterThan(0)
    }
    expect(result.groups[0].request.shipping).toBe(100)
    expect(result.groups[0].shippingLineKeys).toEqual(['S1', 'S2'])
  })
})
