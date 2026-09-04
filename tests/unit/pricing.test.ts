import { describe, it, expect } from 'vitest'
import {
  checkDiscount,
  describeCap,
  lineTotal,
  priceLine,
  resolveBasePrice,
  type ContractPriceRow,
  type ListPriceRow,
} from '@/lib/pricing'
import { computeDraftLineTotal } from '@/lib/customer-invoice/build-draft'

const TODAY = '2026-09-03'
const UR = '45934040176'

const listPrices: ListPriceRow[] = [
  { sku: 'EBH9NA', currency: 'USD', unit_price: '178.00', floor_price: '150.00' },
  { sku: 'EBH9NA', currency: 'CAD', unit_price: '240.00', floor_price: null },
  { sku: 'LTLNA', currency: 'USD', unit_price: '1200.00' },
  { sku: 'RETIRED', currency: 'USD', unit_price: '99.00', is_active: false },
]

describe('resolveBasePrice precedence', () => {
  it('prefers a live contract price over the list price', () => {
    const contract: ContractPriceRow[] = [
      { hubspot_company_id: UR, sku: 'EBH9NA', currency: 'USD', unit_price: '160.00' },
    ]
    const r = resolveBasePrice({ sku: 'EBH9NA', currency: 'USD', companyId: UR, contractPrices: contract, listPrices, today: TODAY })
    expect(r).toEqual({ unitPrice: 160, source: 'contract', floorPrice: 150, contractCompanyId: UR, customerPartNumber: null })
  })

  // The contractor's own code for the product, carried through so the quote
  // line can be matched against the customer's purchase order. Display only:
  // it takes no part in matching, which stays sku + currency + company.
  it('carries the customer part number off a contract price', () => {
    const contract: ContractPriceRow[] = [
      { hubspot_company_id: UR, sku: 'EBH9NA', currency: 'USD', unit_price: '160.00', customer_part_number: 'ECHOBARRIER H9 GREEN' },
    ]
    const r = resolveBasePrice({ sku: 'EBH9NA', currency: 'USD', companyId: UR, contractPrices: contract, listPrices, today: TODAY })
    expect(r.customerPartNumber).toBe('ECHOBARRIER H9 GREEN')
  })

  it('reports no part number rather than an empty string when the contract has none', () => {
    const contract: ContractPriceRow[] = [
      { hubspot_company_id: UR, sku: 'EBH9NA', currency: 'USD', unit_price: '160.00', customer_part_number: '   ' },
    ]
    const r = resolveBasePrice({ sku: 'EBH9NA', currency: 'USD', companyId: UR, contractPrices: contract, listPrices, today: TODAY })
    expect(r.customerPartNumber).toBeNull()
  })

  // MAP is reference only. If it ever leaked into the resolver a rep would be
  // quoted at the advertised price instead of MSRP without anything saying so.
  it('never quotes from map_price', () => {
    const withMap = [{ sku: 'EBH9NA', currency: 'USD', unit_price: '185.00', map_price: '245.00', floor_price: '150.00' }]
    const r = resolveBasePrice({ sku: 'EBH9NA', currency: 'USD', listPrices: withMap, today: TODAY })
    expect(r.unitPrice).toBe(185)
    expect(r.source).toBe('list')
  })

  it('falls back to the list price when the contract belongs to another company', () => {
    const contract: ContractPriceRow[] = [
      { hubspot_company_id: 'someone-else', sku: 'EBH9NA', currency: 'USD', unit_price: '160.00' },
    ]
    const r = resolveBasePrice({ sku: 'EBH9NA', currency: 'USD', companyId: UR, contractPrices: contract, listPrices, today: TODAY })
    expect(r.source).toBe('list')
    expect(r.unitPrice).toBe(178)
  })

  it('falls back to the HubSpot catalogue when no Supabase row exists at all', () => {
    // The rollout case. Every USA product is still a 1.00 placeholder, and the
    // source has to say so out loud rather than pass 1.00 off as a list price.
    const r = resolveBasePrice({ sku: 'NEWSKU', currency: 'USD', listPrices, hubspotPrice: 1, today: TODAY })
    expect(r).toEqual({ unitPrice: 1, source: 'hubspot', floorPrice: null, contractCompanyId: null })
  })

  it('does not cross currencies', () => {
    const r = resolveBasePrice({ sku: 'EBH9NA', currency: 'CAD', listPrices, today: TODAY })
    expect(r.unitPrice).toBe(240)
    expect(r.floorPrice).toBeNull()
  })

  it('ignores an is_active false row but treats a missing column as active', () => {
    const off = resolveBasePrice({ sku: 'RETIRED', currency: 'USD', listPrices, hubspotPrice: 5, today: TODAY })
    expect(off.source).toBe('hubspot')
    const on = resolveBasePrice({ sku: 'LTLNA', currency: 'USD', listPrices, today: TODAY })
    expect(on.source).toBe('list')
  })

  it('matches SKU and currency past the whitespace and case a human types', () => {
    const r = resolveBasePrice({ sku: '  ebh9na ', currency: 'usd', listPrices, today: TODAY })
    expect(r.unitPrice).toBe(178)
  })
})

describe('resolveBasePrice validity windows', () => {
  const row = (valid_from: string | null, valid_to: string | null): ContractPriceRow => ({
    hubspot_company_id: UR, sku: 'EBH9NA', currency: 'USD', unit_price: '160.00', valid_from, valid_to,
  })
  const resolve = (contractPrices: ContractPriceRow[]) =>
    resolveBasePrice({ sku: 'EBH9NA', currency: 'USD', companyId: UR, contractPrices, listPrices, today: TODAY })

  it('treats both bounds as inclusive, so a contract starting today is live today', () => {
    expect(resolve([row(TODAY, null)]).source).toBe('contract')
    expect(resolve([row(null, TODAY)]).source).toBe('contract')
  })

  it('ignores a contract that has not started or has expired', () => {
    expect(resolve([row('2026-09-04', null)]).source).toBe('list')
    expect(resolve([row(null, '2026-09-02')]).source).toBe('list')
  })

  it('treats both bounds null as open ended', () => {
    expect(resolve([row(null, null)]).source).toBe('contract')
  })

  it('takes the LATEST valid_from among several live contracts', () => {
    // Two overlapping agreements is the renegotiation case, and quoting the
    // older number is the expensive direction to get it wrong.
    const rows: ContractPriceRow[] = [
      { hubspot_company_id: UR, sku: 'EBH9NA', currency: 'USD', unit_price: '160.00', valid_from: '2026-01-01' },
      { hubspot_company_id: UR, sku: 'EBH9NA', currency: 'USD', unit_price: '171.00', valid_from: '2026-08-01' },
      { hubspot_company_id: UR, sku: 'EBH9NA', currency: 'USD', unit_price: '150.00', valid_from: null },
    ]
    expect(resolve(rows).unitPrice).toBe(171)
  })

  it('reports NO floor when the contract price already sits below it', () => {
    // Dave's own negotiated deal must not be vetoed by the general floor, and
    // the rep must not be warned about a limit their base is already under.
    const rows: ContractPriceRow[] = [
      { hubspot_company_id: UR, sku: 'EBH9NA', currency: 'USD', unit_price: '140.00' },
    ]
    const r = resolve(rows)
    expect(r.unitPrice).toBe(140)
    expect(r.floorPrice).toBeNull()
  })
})

describe('priceLine stores what each downstream system needs', () => {
  // THE invariant: the pair written to line_items_raw must reproduce the net
  // price through the formula the customer invoice bills with. If this drifts,
  // the quote and the invoice disagree in front of a customer.
  const cases: { base: number; input: Parameters<typeof priceLine>[1]; net: number }[] = [
    { base: 178, input: { mode: 'percent', value: 10 }, net: 160.2 },
    { base: 178, input: { mode: 'percent', value: 7.5 }, net: 164.65 },
    { base: 178, input: { mode: 'amount', value: 11.11 }, net: 166.89 },
    { base: 1200, input: { mode: 'amount', value: 200 }, net: 1000 },
    { base: 99.99, input: { mode: 'percent', value: 33.33 }, net: 66.66 },
    { base: 178, input: null, net: 178 },
  ]

  for (const { base, input, net } of cases) {
    it(`base ${base} ${input ? `${input.mode} ${input.value}` : 'undiscounted'} reproduces its net through the invoice formula`, () => {
      const line = priceLine(base, input)
      expect(line.netUnitPrice).toBe(net)
      expect(computeDraftLineTotal(1, line.registry.unit_price, line.registry.discount_percentage)).toBe(net)
    })
  }

  it('sends HubSpot the BASE price plus a percentage, never the net', () => {
    const line = priceLine(178, { mode: 'percent', value: 10 })
    expect(line.hubspot).toEqual({ price: 178, hs_discount_percentage: 10 })
    expect(line.registry).toEqual({ unit_price: 178, discount_percentage: 10 })
  })

  it('sends HubSpot the base plus a per-unit discount, but stores the NET with no percentage', () => {
    // The amount mode deliberately hands the invoice an exact net so nothing
    // downstream can round the discount differently.
    const line = priceLine(178, { mode: 'amount', value: 11.11 })
    expect(line.hubspot).toEqual({ price: 178, discount: 11.11 })
    expect(line.registry).toEqual({ unit_price: 166.89, discount_percentage: 0 })
  })

  it('never sends both discount properties, which HubSpot would stack', () => {
    for (const input of [{ mode: 'percent' as const, value: 10 }, { mode: 'amount' as const, value: 10 }]) {
      const { hubspot } = priceLine(178, input)
      const present = [hubspot.hs_discount_percentage, hubspot.discount].filter((v) => v !== undefined)
      expect(present).toHaveLength(1)
    }
  })

  it('clamps junk to a safe undiscounted line rather than throwing', () => {
    const undiscounted = { listUnitPrice: 178, netUnitPrice: 178, registry: { unit_price: 178, discount_percentage: 0 }, hubspot: { price: 178 } }
    expect(priceLine(178, { mode: 'percent', value: -5 })).toEqual(undiscounted)
    expect(priceLine(178, { mode: 'percent', value: 101 })).toEqual(undiscounted)
    expect(priceLine(178, { mode: 'percent', value: Number.NaN })).toEqual(undiscounted)
    expect(priceLine(178, { mode: 'amount', value: 0 })).toEqual(undiscounted)
  })

  it('stops a per-unit discount at free instead of going negative', () => {
    const line = priceLine(178, { mode: 'amount', value: 500 })
    expect(line.netUnitPrice).toBe(0)
    expect(line.hubspot.discount).toBe(178)
  })

  it('treats a negative base price as corrupt data, not a credit note', () => {
    expect(priceLine(-50, null).listUnitPrice).toBe(0)
  })
})

describe('lineTotal', () => {
  it('agrees with the invoice to the cent on the real Test-UR quantity', () => {
    const line = priceLine(178, { mode: 'percent', value: 10 })
    expect(lineTotal(499, line)).toBe(79939.8)
    expect(lineTotal(499, line)).toBe(
      computeDraftLineTotal(499, line.registry.unit_price, line.registry.discount_percentage),
    )
  })

  it('is zero for a zero quantity and never NaN for junk', () => {
    const line = priceLine(178, null)
    expect(lineTotal(0, line)).toBe(0)
    expect(lineTotal('nonsense', line)).toBe(0)
  })
})

describe('checkDiscount', () => {
  const discounted = priceLine(178, { mode: 'percent', value: 10 })

  it('allows an undiscounted line even for a rep with no cap row', () => {
    // Otherwise an unconfigured rep could not quote at all.
    expect(checkDiscount({ line: priceLine(178, null), cap: null })).toBeNull()
  })

  it('refuses ANY discount when the rep has no cap row', () => {
    // Absence is the strict case. Defaulting to unlimited would hand every
    // unconfigured rep a blank cheque.
    expect(checkDiscount({ line: discounted, cap: null })).toBe('You are not allowed to apply a discount')
    expect(checkDiscount({ line: discounted, cap: {} })).toBe('You are not allowed to apply a discount')
    expect(checkDiscount({ line: discounted, cap: { max_discount_pct: null, max_discount_per_unit: null } }))
      .toBe('You are not allowed to apply a discount')
  })

  it('passes a discount that lands EXACTLY on the limit', () => {
    expect(checkDiscount({ line: discounted, cap: { max_discount_pct: 10 } })).toBeNull()
    expect(checkDiscount({ line: priceLine(178, { mode: 'amount', value: 30 }), cap: { max_discount_per_unit: 30 } })).toBeNull()
  })

  it('names the numbers when a percentage cap bites', () => {
    expect(checkDiscount({ line: priceLine(178, { mode: 'percent', value: 15 }), cap: { max_discount_pct: 10 } }))
      .toBe('Discount of 15% is above your limit of 10%')
  })

  it('names the numbers when a per-unit cap bites, in the deal currency', () => {
    const line = priceLine(178, { mode: 'amount', value: 40 })
    expect(checkDiscount({ line, cap: { max_discount_per_unit: 30 } }))
      .toBe('A discount of $40.00 per unit is above your limit of $30.00 per unit')
    expect(checkDiscount({ line, cap: { max_discount_per_unit: 30 }, currency: 'CAD' }))
      .toBe('A discount of CA$40.00 per unit is above your limit of CA$30.00 per unit')
  })

  it('applies a percentage cap to a discount typed as cash, so the cap cannot be routed around', () => {
    // 40 off 178 is 22.47 percent however the rep enters it.
    const asAmount = priceLine(178, { mode: 'amount', value: 40 })
    expect(checkDiscount({ line: asAmount, cap: { max_discount_pct: 10 } })).toMatch(/above your limit of 10%/)
  })

  it('enforces every cap that is set, not just the first', () => {
    const line = priceLine(178, { mode: 'percent', value: 5 })
    expect(checkDiscount({ line, cap: { max_discount_pct: 10, max_discount_per_unit: 30 } })).toBeNull()
    expect(checkDiscount({ line, cap: { max_discount_pct: 10, max_discount_per_unit: 5 } })).toMatch(/per unit/)
  })

  it('refuses a net price under the item floor', () => {
    const line = priceLine(178, { mode: 'percent', value: 20 })
    expect(checkDiscount({ line, cap: { max_discount_pct: 50 }, floorPrice: 150 }))
      .toBe('That price is below the $150.00 floor for this item')
  })

  it('lets a super admin through every cap and the floor', () => {
    const line = priceLine(178, { mode: 'percent', value: 90 })
    expect(checkDiscount({ line, cap: null, floorPrice: 150, isSuperAdmin: true })).toBeNull()
  })

  it('reads a cap that arrived from Supabase as a string', () => {
    expect(checkDiscount({ line: discounted, cap: { max_discount_pct: '10.00' } })).toBeNull()
    expect(checkDiscount({ line: discounted, cap: { max_discount_pct: '5.00' } })).toMatch(/above your limit of 5%/)
  })

  it('treats a cap of zero as a real cap, not as absent', () => {
    expect(checkDiscount({ line: discounted, cap: { max_discount_pct: 0 } }))
      .toBe('Discount of 10% is above your limit of 0%')
  })
})

describe('describeCap', () => {
  it('states both limits when both are set', () => {
    expect(describeCap({ max_discount_pct: 10, max_discount_per_unit: 30 }, 'USD')).toBe('Your limit: 10% or $30.00 per unit')
  })

  it('states just the one that is set', () => {
    expect(describeCap({ max_discount_pct: 10 }, 'USD')).toBe('Your limit: 10%')
    expect(describeCap({ max_discount_per_unit: 30 }, 'CAD')).toBe('Your limit: CA$30.00 per unit')
  })

  it('says so plainly when there is no cap row at all', () => {
    expect(describeCap(null, 'USD')).toBe('You cannot apply a discount')
    expect(describeCap({}, 'USD')).toBe('You cannot apply a discount')
  })
})
