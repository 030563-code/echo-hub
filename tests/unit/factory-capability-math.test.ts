import { describe, it, expect } from 'vitest'
import {
  alertSignature,
  anythingShort,
  materialNeeds,
  productCapabilities,
  productDraw,
  productLabel,
  type CapabilityStatusRow,
  type FactoryBomProduct,
  type SkuMapRow,
} from '@/lib/factory/capability-math'
import type { BomComponentRow } from '@/lib/mrp/materials'

/**
 * The factory's product table and the low-stock alert, without a database.
 * Bamida's CEO, 18 Sep 2026: alert the warehouse when any material runs low.
 */

const products: FactoryBomProduct[] = [
  { fg_code: '000716', fg_label: 'Vyroba Echo Barrier H9 (1335 x 2050 mm)', pallet_size: 70 },
  { fg_code: '000750', fg_label: 'Vyroba Echo Barrier HT 3,5 (3650 x 2050mm)', pallet_size: 30 },
]

const components: BomComponentRow[] = [
  { fg_code: '000716', component_code: '5097', component_desc: 'Mehler', qty: 2.4, basis: 'per_unit', line_type: 'material', is_gating: true },
  { fg_code: '000716', component_code: '1781', component_desc: 'Kovové istenie', qty: 1, basis: 'per_pallet', line_type: 'material', is_gating: true },
  { fg_code: '000716', component_code: 'INK', component_desc: 'Ink', qty: 0.01, basis: 'per_unit', line_type: 'material', is_gating: false },
  { fg_code: '000716', component_code: '340', component_desc: 'Šitie', qty: 12, basis: 'per_unit', line_type: 'operation', is_gating: false },
  { fg_code: '000750', component_code: '5097', component_desc: 'Mehler', qty: 6, basis: 'per_unit', line_type: 'material', is_gating: true },
]

// 1781 caps H9 at four pallets, which is 280 units. Mehler is not the binding one.
const stock = new Map([['5097', 24586], ['1781', 4]])

const skuMap: SkuMapRow[] = [{ hub_sku: 'EBH9NA', fg_code: '000716', confirmed: false }]
const names = new Map([['EBH9NA', 'Echo Barrier H9']])

const status = (over: Partial<CapabilityStatusRow> = {}): CapabilityStatusRow[] => [
  { sku: 'EBH9NA', run_date: '2026-09-18', action_qty: 0, flags: ['bom_estimated'], ...over },
]

const build = (over: Partial<CapabilityStatusRow> = {}) =>
  productCapabilities({ products, components, stockByCode: stock, skuMap, status: status(over), names })

describe('productCapabilities', () => {
  it('lists every product with a bill of materials, mapped to a SKU or not', () => {
    const out = build()
    // 🔴 Eighteen delivery notes are loaded and only six carry a Hub SKU. The
    // ceiling needs their parts list and their shelf, not our SKU, so a product
    // we do not sell in North America still gets a row.
    expect(out.map((p) => p.fgCode).sort()).toEqual(['000716', '000750'])
    const ht = out.find((p) => p.fgCode === '000750')!
    expect(ht.productName).toBe('Echo Barrier HT 3,5 (3650 x 2050mm)')
    expect(ht.requirement).toBeNull()
    expect(ht.short).toBe(false)
    expect(ht.maxBuildable).toBe(Math.floor(24586 / 6))
  })

  it('computes the ceiling from their feed and names what binds it', () => {
    const [h9] = build().filter((p) => p.fgCode === '000716')
    expect(h9.productName).toBe('Echo Barrier H9')
    expect(h9.maxBuildable).toBe(280)
    expect(h9.bindingCode).toBe('1781')
    expect(h9.bindingDesc).toBe('Kovové istenie')
  })

  it('never lets our own position onto a factory object', () => {
    // The whole boundary, as one assertion. A field added here reaches Bamida's
    // browser through the client table, so adding one is a deliberate act.
    expect(Object.keys(build()[0]).sort()).toEqual([
      'bindingCode',
      'bindingDesc',
      'fgCode',
      'maxBuildable',
      'palletSize',
      'productName',
      'provisional',
      'requirement',
      'short',
    ])
  })

  it('is short only when the requirement exceeds what the materials allow', () => {
    expect(build({ action_qty: 100 })[0].short).toBe(false)
    const short = build({ action_qty: 754 }).find((p) => p.fgCode === '000716')!
    expect(short.short).toBe(true)
    expect(short.requirement).toBe(754)
    // A requirement of zero is never short, however low the ceiling.
    expect(build({ action_qty: 0 }).find((p) => p.fgCode === '000716')!.short).toBe(false)
    // No forecast is not a shortage either.
    expect(build().find((p) => p.fgCode === '000750')!.short).toBe(false)
  })

  it('never prints a negative requirement, whatever the engine sends', () => {
    expect(build({ action_qty: -12 }).find((p) => p.fgCode === '000716')!.requirement).toBe(0)
  })

  it('adds the requirements of every SKU built from the same finished good', () => {
    const out = productCapabilities({
      products,
      components,
      stockByCode: stock,
      skuMap: [...skuMap, { hub_sku: 'EBH9ERNA', fg_code: '000716', confirmed: false }],
      status: [...status({ action_qty: 100 }), { sku: 'EBH9ERNA', run_date: '2026-09-18', action_qty: 40, flags: [] }],
      names,
    })
    expect(out.find((p) => p.fgCode === '000716')!.requirement).toBe(140)
  })

  it('marks the mapping provisional until somebody confirms it, and says so when there is none', () => {
    expect(build().find((p) => p.fgCode === '000716')!.provisional).toBe(true)
    expect(build().find((p) => p.fgCode === '000750')!.provisional).toBe(true)
    const confirmed = productCapabilities({
      products,
      components,
      stockByCode: stock,
      skuMap: [{ hub_sku: 'EBH9NA', fg_code: '000716', confirmed: true }],
      status: status(),
      names,
    })
    expect(confirmed.find((p) => p.fgCode === '000716')!.provisional).toBe(false)
  })

  it('puts short products first, then the biggest requirement, then no forecast at all', () => {
    expect(build({ action_qty: 754 }).map((p) => p.fgCode)).toEqual(['000716', '000750'])
  })

  it('reads the product name off their own delivery note when we have no better one', () => {
    expect(productLabel({ fg_code: 'x', fg_label: 'Výroba Echo Barrier V1 (2450 x 1950mm)', pallet_size: null }))
      .toBe('Echo Barrier V1 (2450 x 1950mm)')
    expect(productLabel({ fg_code: '000957', fg_label: null, pallet_size: null })).toBe('000957')
  })
})

describe('materialNeeds', () => {
  it('explodes the requirement into material quantities, per unit and per pallet', () => {
    const needs = materialNeeds(build({ action_qty: 71 }), components, stock)
    // 71 units of a 70-per-pallet product is two pallets of packing.
    expect(needs.get('1781')).toMatchObject({ needed: 2, have: 4, short: 0 })
    expect(needs.get('5097')).toMatchObject({ needed: 71 * 2.4, have: 24586, short: 0 })
    // Non-gating rows are not on their feed and are not reported.
    expect(needs.has('INK')).toBe(false)
  })

  it('names the shortfall in material units, never negative, and unknown stock is not zero', () => {
    const needs = materialNeeds(build({ action_qty: 700 }), components, new Map([['1781', 4]]))
    expect(needs.get('1781')).toMatchObject({ needed: 10, have: 4, short: 6, products: ['Echo Barrier H9'] })
    expect(needs.get('5097')).toMatchObject({ have: null, short: 0 })
  })

  it('ignores products with nothing required', () => {
    expect(materialNeeds(build({ action_qty: 0 }), components, stock).size).toBe(0)
  })
})

describe('productDraw', () => {
  const h9 = () => build({ action_qty: 754 }).find((p) => p.fgCode === '000716')!

  it('shows the arithmetic line by line so a person can check it by hand', () => {
    const rows = productDraw(h9(), components, stock, 100)
    const mehler = rows.find((r) => r.code === '5097')!
    expect(mehler).toMatchObject({ perUnit: 2.4, perPallet: 0, needed: 240, have: 24586, short: 0, gating: true })
    // 100 units at 70 per pallet is two whole pallets, not 1.43.
    const packing = rows.find((r) => r.code === '1781')!
    expect(packing).toMatchObject({ perPallet: 1, needed: 2, have: 4, short: 0, binding: true })
  })

  it('carries the lines their feed does not report, marked as unknown rather than zero', () => {
    const ink = productDraw(h9(), components, stock, 100).find((r) => r.code === 'INK')!
    expect(ink).toMatchObject({ have: null, short: 0, gating: false })
  })

  it('leaves operations out: they are labour, not stock', () => {
    expect(productDraw(h9(), components, stock, 100).some((r) => r.code === '340')).toBe(false)
  })

  it('puts the shortfalls at the top', () => {
    const rows = productDraw(h9(), components, new Map([['5097', 10], ['1781', 4]]), 100)
    expect(rows[0].code).toBe('5097')
    expect(rows[0].short).toBe(230)
  })
})

describe('the alert signature', () => {
  const needsFor = (qty: number, packing: number) =>
    materialNeeds(build({ action_qty: qty }), components, new Map([['1781', packing]]))

  it('is the same for the same picture and different for any change', () => {
    const a = build({ action_qty: 700 })
    expect(alertSignature(a, needsFor(700, 4))).toBe(alertSignature(build({ action_qty: 700 }), needsFor(700, 4)))
    expect(alertSignature(a, needsFor(700, 4))).toBe('products=000716:700>280;materials=1781:6')
    expect(alertSignature(a, needsFor(700, 3))).not.toBe(alertSignature(a, needsFor(700, 4)))
  })

  it('knows when there is nothing to say', () => {
    const quiet = build({ action_qty: 10 })
    const needs = materialNeeds(quiet, components, stock)
    expect(anythingShort(quiet, needs)).toBe(false)
    expect(anythingShort(build({ action_qty: 754 }), needs)).toBe(true)
  })
})
