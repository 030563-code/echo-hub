import { describe, it, expect } from 'vitest'
import {
  alertSignature,
  anythingShort,
  materialNeeds,
  productCapabilities,
  type CapabilityStatusRow,
  type SkuMapRow,
} from '@/lib/factory/capability-math'
import type { BomComponentRow, BomProductRow } from '@/lib/mrp/materials'

/**
 * The factory's product table and the low-stock alert, without a database.
 * Bamida's CEO, 18 Sep 2026: alert the warehouse when any material runs low.
 */

const row = (over: Partial<CapabilityStatusRow>): CapabilityStatusRow => ({
  sku: 'EBH9NA',
  run_date: '2026-09-18',
  max_buildable: 280,
  materials_binding_code: '1781',
  materials_binding_desc: 'Kovové istenie',
  action_qty: 0,
  firm_demand: 0,
  qualified_spikes: 0,
  on_hand: 2660,
  in_transit: 0,
  on_order: 350,
  flags: ['bom_estimated', 'materials_map_provisional'],
  ...over,
})

const skuMap: SkuMapRow[] = [
  { hub_sku: 'EBH9NA', fg_code: '000716', confirmed: false },
  { hub_sku: 'EBH9XNA', fg_code: '000726', confirmed: true },
]
const names = new Map([
  ['EBH9NA', 'Echo Barrier H9'],
  ['EBH9XNA', 'Echo Barrier H9X'],
])

describe('productCapabilities', () => {
  it('lines the engine row up per product and drops SKUs with no bill of materials', () => {
    const out = productCapabilities([row({}), row({ sku: 'BUNNA', max_buildable: null })], skuMap, names)
    expect(out.map((p) => p.sku)).toEqual(['EBH9NA'])
    expect(out[0].productName).toBe('Echo Barrier H9')
    expect(out[0].maxBuildable).toBe(280)
    expect(out[0].bindingDesc).toBe('Kovové istenie')
    expect(out[0].onOrder).toBe(350)
  })

  it('is short only when the requirement exceeds what the materials allow', () => {
    const [ok] = productCapabilities([row({ action_qty: 100 })], skuMap, names)
    expect(ok.short).toBe(false)
    const [short] = productCapabilities([row({ action_qty: 754, max_buildable: 200 })], skuMap, names)
    expect(short.short).toBe(true)
    expect(short.requirement).toBe(754)
    // A requirement of zero is never short, however low the ceiling.
    const [idle] = productCapabilities([row({ action_qty: 0, max_buildable: 0 })], skuMap, names)
    expect(idle.short).toBe(false)
    // An unknown ceiling cannot be short: unknown is not zero.
    const [unknown] = productCapabilities([row({ action_qty: 500, max_buildable: null })], skuMap, names)
    expect(unknown.short).toBe(false)
  })

  it('never prints a negative requirement, whatever the engine sends', () => {
    const [p] = productCapabilities([row({ action_qty: -12 })], skuMap, names)
    expect(p.requirement).toBe(0)
  })

  it('marks the mapping provisional until somebody confirms it', () => {
    const [h9] = productCapabilities([row({})], skuMap, names)
    expect(h9.provisional).toBe(true)
    const [h9x] = productCapabilities([row({ sku: 'EBH9XNA', flags: [] })], skuMap, names)
    expect(h9x.provisional).toBe(false)
  })

  it('puts short products first, then the biggest requirement', () => {
    const out = productCapabilities(
      [
        row({ sku: 'EBH9NA', action_qty: 50 }),
        row({ sku: 'EBH9XNA', action_qty: 754, max_buildable: 200, flags: [] }),
      ],
      skuMap,
      names,
    )
    expect(out.map((p) => p.sku)).toEqual(['EBH9XNA', 'EBH9NA'])
  })
})

const bomProducts: BomProductRow[] = [{ fg_code: '000716', pallet_size: 70 }]
const components: BomComponentRow[] = [
  { fg_code: '000716', component_code: '5097', component_desc: 'Mehler', qty: 2.4, basis: 'per_unit', line_type: 'material', is_gating: true },
  { fg_code: '000716', component_code: '1781', component_desc: 'Kovové istenie', qty: 1, basis: 'per_pallet', line_type: 'material', is_gating: true },
  { fg_code: '000716', component_code: 'INK', component_desc: 'Ink', qty: 1, basis: 'per_unit', line_type: 'material', is_gating: false },
]

describe('materialNeeds', () => {
  it('explodes the requirement into material quantities, per unit and per pallet', () => {
    const [p] = productCapabilities([row({ action_qty: 71 })], skuMap, names)
    const needs = materialNeeds([p], skuMap, bomProducts, components, new Map([['5097', 24586], ['1781', 4]]))
    // 71 units of a 70-per-pallet product is two pallets of packing.
    expect(needs.get('1781')).toMatchObject({ needed: 2, have: 4, short: 0 })
    expect(needs.get('5097')).toMatchObject({ needed: 71 * 2.4, have: 24586, short: 0 })
    // Non-gating rows are not on their feed and are not reported.
    expect(needs.has('INK')).toBe(false)
  })

  it('names the shortfall in material units, never negative, and unknown stock is not zero', () => {
    const [p] = productCapabilities([row({ action_qty: 700 })], skuMap, names)
    const needs = materialNeeds([p], skuMap, bomProducts, components, new Map([['1781', 4]]))
    expect(needs.get('1781')).toMatchObject({ needed: 10, have: 4, short: 6, products: ['Echo Barrier H9'] })
    expect(needs.get('5097')).toMatchObject({ have: null, short: 0 })
  })

  it('ignores products with nothing required', () => {
    const [p] = productCapabilities([row({ action_qty: 0 })], skuMap, names)
    expect(materialNeeds([p], skuMap, bomProducts, components, new Map()).size).toBe(0)
  })
})

describe('the alert signature', () => {
  it('is the same for the same picture and different for any change', () => {
    const [a] = productCapabilities([row({ action_qty: 700, max_buildable: 280 })], skuMap, names)
    const needsA = materialNeeds([a], skuMap, bomProducts, components, new Map([['1781', 4]]))
    const [b] = productCapabilities([row({ action_qty: 700, max_buildable: 280 })], skuMap, names)
    const needsB = materialNeeds([b], skuMap, bomProducts, components, new Map([['1781', 4]]))
    expect(alertSignature(a ? [a] : [], needsA)).toBe(alertSignature(b ? [b] : [], needsB))
    expect(alertSignature([a], needsA)).toBe('products=EBH9NA:700>280;materials=1781:6')

    const [c] = productCapabilities([row({ action_qty: 700, max_buildable: 280 })], skuMap, names)
    const needsC = materialNeeds([c], skuMap, bomProducts, components, new Map([['1781', 3]]))
    expect(alertSignature([c], needsC)).not.toBe(alertSignature([a], needsA))
  })

  it('knows when there is nothing to say', () => {
    const [p] = productCapabilities([row({ action_qty: 10 })], skuMap, names)
    const needs = materialNeeds([p], skuMap, bomProducts, components, new Map([['1781', 4], ['5097', 1000]]))
    expect(anythingShort([p], needs)).toBe(false)
    const [s] = productCapabilities([row({ action_qty: 754, max_buildable: 200 })], skuMap, names)
    expect(anythingShort([s], needs)).toBe(true)
  })
})
