import { describe, it, expect } from 'vitest'
import type { SpecDraft, SpecDraftProduct } from '@/lib/po-spec-draft'
import {
  assemblePackingLists,
  documentDateLabel,
  GROUP_LETTERHEAD,
  hasMeshBack,
  packingListFilename,
  packingSourceFromSpec,
  partyFromDeliveryAddress,
  productDescription,
  SRO_LETTERHEAD,
  type PackingListForm,
} from '@/lib/despatch/packing-list-source'

/**
 * The live order EBSRO8001-1 as Juraj signed it on 17 Sep 2026: three
 * products, the specification rows exactly as po_spec_document holds them,
 * eight pallets signed. Every expectation below is what the packing list for
 * that order has to say.
 */

function product(model: string, name: string, quantity: number, packSize: number, rows: [string, string][]): SpecDraftProduct {
  return {
    model,
    name,
    quantity,
    packSize,
    pallets: Math.ceil(quantity / packSize),
    materials: [],
    specRows: rows.map(([label, value]) => ({ label, value })),
    bullets: [],
    sourceDocument: null,
  }
}

const H9 = product('H9', 'Echo Barrier H9', 350, 70, [
  ['Dimensions', '1335 x 2050 mm'],
  ['PVC', 'PVC Mehler 900gr/ B1/matný lak L&B 8540-636 / Zelená/Green / RAL 6026'],
  ['Goretex', 'PC350FR Grade 6 /2,1m (600*600 PU 2,1m) FR/WR/Solution Dyed / Čierna/Black'],
  ['Pallet type', '210x140cm FYTO'],
  ['Frame (konštrukcia)', 'Ano'],
  ['Pallet height', 'MAX výška palety 235 cm !!!'],
  ['Pack (balenie)', '5x70 ks'],
])
const V2 = product('V2', 'Echo Barrier V2', 5, 5, [
  ['Dimensions', '2330 x 1885 mm'],
  ['Pallet type', 'označená'],
  ['Frame (konštrukcia)', 'NIE'],
  ['Pallet height', 'MAX výška palety 245 cm !!!'],
])
const CSC = product('CSCompact', 'Compact Cutting Station', 5, 5, [
  ['Dimensions', 'CS barrier ( tlačový súbor 2500 x 2050mm )'],
  ['Pallet type', 'FYTO/210x140 a'],
  ['Pallet height', 'MAX výška palety 245 cm !!!'],
  ['Pack (balenie)', '5 na paletu'],
])

const draft: SpecDraft = {
  destination: 'US Baltimore',
  products: [H9, V2, CSC],
  packing: { pallets: 8, palletCovers: 8, metalFrames: 6 },
}

const lines = [
  { sku: 'EBH9NA', hs_code: null },
  { sku: 'V2NA', hs_code: null },
  { sku: 'CCSNA', hs_code: null },
]
const modelBySku = new Map<string, string | null>([
  ['EBH9NA', 'H9'],
  ['V2NA', 'V2'],
  ['CCSNA', 'CSCompact'],
])
const noCodes = new Map<string, string>()

describe('reading the signed specification', () => {
  const source = packingSourceFromSpec({ draft, lines, modelBySku, hsBySku: noCodes, poReference: 'EBGRP8001' })

  it('names each product the way the documents do, with a plain size only', () => {
    expect(source.products.map((p) => p.description)).toEqual([
      'Echo Barrier H9 (1335 x 2050 mm)',
      'Echo Barrier V2 (2330 x 1885 mm)',
      // The cutting station's Dimensions row is its print file, not the product.
      'Compact Cutting Station',
    ])
  })

  it('takes the signed quantity, pack size and pallet count, never recomputing them', () => {
    expect(source.products.map((p) => [p.quantity, p.packSize])).toEqual([
      [350, 70],
      [5, 5],
      [5, 5],
    ])
    expect(source.signedPallets).toBe(8)
  })

  it('prints the Group order number in their PO column on every line', () => {
    expect(source.products.every((p) => p.poReference === 'EBGRP8001')).toBe(true)
  })

  it('reads the packing size off the pallet rows, and leaves it blank rather than borrowing one', () => {
    expect(source.products.map((p) => p.packingSize)).toEqual([
      '210 x 140 cm / height 235 cm',
      'height 245 cm',
      '210 x 140 cm / height 245 cm',
    ])
    expect(source.warnings).toHaveLength(1)
    expect(source.warnings[0]).toMatch(/^V2: the specification names no pallet size \(Pallet type says "označená"\)/)
    expect(source.warnings[0]).toContain('prints the height only')
  })

  it('weighs this H9 without a mesh back, because the signed specification has no Mesh row', () => {
    expect(source.products[0].hasMesh).toBe(false)
  })

  it('has no pallet count when nothing was signed', () => {
    const unsigned = packingSourceFromSpec({
      draft: { ...draft, packing: { pallets: 0, palletCovers: 0, metalFrames: 0 } },
      lines,
      modelBySku,
      hsBySku: noCodes,
      poReference: null,
    })
    expect(unsigned.signedPallets).toBeNull()
  })
})

describe('the mesh back', () => {
  it('is there when the row says a fabric, and not when it says dashes or nothing', () => {
    expect(hasMeshBack(product('H10', 'H10', 1, 70, [['Mesh (sieťka)', 'Ferrari 362']]))).toBe(true)
    expect(hasMeshBack(product('H9X', 'H9X', 1, 70, [['Mesh (sieťka)', '-----------------------']]))).toBe(false)
    expect(hasMeshBack(H9)).toBe(false)
  })
})

describe('the HS code', () => {
  it('takes the code typed on the order line before the HS codes tab', () => {
    const source = packingSourceFromSpec({
      draft,
      lines: [{ sku: 'EBH9NA', hs_code: ' 3926.90 ' }, ...lines.slice(1)],
      modelBySku,
      hsBySku: new Map([['EBH9NA', '3926.90.9985']]),
      poReference: null,
    })
    expect(source.products[0].hsCode).toBe('3926.90')
  })

  it('falls back to the tab, then to nothing', () => {
    const fromTab = packingSourceFromSpec({ draft, lines, modelBySku, hsBySku: new Map([['V2NA', '3926 90 97']]), poReference: null })
    expect(fromTab.products.map((p) => p.hsCode)).toEqual([null, '3926 90 97', null])
  })

  it('says when no order line maps to a model, because then no code can be looked up', () => {
    const source = packingSourceFromSpec({
      draft,
      lines,
      modelBySku: new Map([
        ['EBH9NA', 'H9'],
        ['V2NA', 'V2'],
      ]),
      hsBySku: noCodes,
      poReference: null,
    })
    expect(source.warnings.some((w) => w.startsWith('CSCompact: no line on the order maps to it'))).toBe(true)
  })
})

describe('the two copies for EBSRO8001-1', () => {
  const form: PackingListForm = {
    date: '2026-10-09',
    consignee: { name: 'Echo Barrier USA LLC', address: ['Capitol Warehouse', '8125 Stayton Drive', 'Jessup', 'MD 20794', 'USA'] },
    deliverTo: { name: 'Echo Barrier USA LLC', address: ['Capitol Warehouse', '8125 Stayton Drive', 'Jessup', 'MD 20794', 'USA'] },
    attention: { name: null, phone: null, email: null },
    incoterms: 'DAP Jessup',
    firstPalletNumber: 1,
    comments: null,
  }
  const source = packingSourceFromSpec({ draft, lines, modelBySku, hsBySku: noCodes, poReference: 'EBGRP8001' })
  const { a, b, warnings } = assemblePackingLists({ placeOfCollection: ['Košická 28', '080 01 Prešov', 'Slovakia'], source }, form)

  it('makes seven pallets and prints the eight that were signed', () => {
    expect(a.pallets).toHaveLength(7)
    expect(a.units).toBe(8)
    expect(warnings.some((w) => w.includes('says 8 pallets and the products make 7'))).toBe(true)
  })

  it('weighs the five H9 pallets at 5.0 kg a barrier, the cutting stations at 60, and the V2 at nothing yet', () => {
    expect(a.pallets.slice(0, 5).every((p) => p.netKg === 350 && p.grossKg === 400)).toBe(true)
    expect(a.pallets[5]).toMatchObject({ description: 'Acoustic barriers (V2 = 5 pcs)', netKg: 0, grossKg: 0 })
    expect(a.pallets[6]).toMatchObject({ description: 'Acoustic barriers (CSCompact = 5 pcs)', netKg: 300, grossKg: 350 })
    expect(a.totalNetKg).toBe(2050)
    expect(a.totalGrossKg).toBe(2350)
    expect(warnings.some((w) => w.startsWith('No weight held for V2'))).toBe(true)
  })

  it('numbers the pallets from the despatch month and the counter typed', () => {
    expect(a.date).toBe('9/10/26')
    expect(a.pallets[0].ref).toBe('(2026/10/I)')
    expect(a.pallets[6].ref).toBe('(2026/10/VII)')
  })

  it('says every line is missing its HS code', () => {
    expect(a.lines.every((l) => l.hsCode === null)).toBe(true)
    expect(warnings.filter((w) => w.startsWith('No HS code for')).map((w) => w.split(' ')[4])).toEqual(['H9.', 'V2.', 'CSCompact.'])
  })

  it('puts the B copy on Group letterhead with the same pallets, weights and consignee', () => {
    expect(a.issuer).toBe(SRO_LETTERHEAD)
    expect(b.variant).toBe('B')
    expect(b.issuer).toBe(GROUP_LETTERHEAD)
    expect(b.pallets).toEqual(a.pallets)
    expect(b.totalGrossKg).toBe(a.totalGrossKg)
    expect(b.consignee).toEqual(form.consignee)
    expect(b.placeOfCollection).toEqual(['Košická 28', '080 01 Prešov', 'Slovakia'])
  })

  it('carries the specification warnings and the builder warnings together', () => {
    expect(warnings[0]).toMatch(/^V2: the specification names no pallet size/)
    expect(warnings.length).toBeGreaterThan(4)
  })
})

describe('the small helpers', () => {
  it('turns a stored delivery address into a party, dropping the depot labels in front', () => {
    const stored = 'US — Baltimore depot — Capitol Warehouse, 8125 Stayton Drive, Jessup, MD 20794, USA'
    expect(partyFromDeliveryAddress('Echo Barrier USA LLC', stored)).toEqual({
      name: 'Echo Barrier USA LLC',
      address: ['Capitol Warehouse', '8125 Stayton Drive', 'Jessup', 'MD 20794', 'USA'],
    })
    expect(partyFromDeliveryAddress('X', null)).toEqual({ name: 'X', address: [] })
  })

  it('writes the date and the filename the way they do', () => {
    expect(documentDateLabel('2026-09-11')).toBe('11/9/26')
    expect(packingListFilename('A', 'US Baltimore', '2026-10-09')).toBe('PL-A US Baltimore 09.10.2026.pdf')
    expect(packingListFilename('B', null, '2026-10-09')).toBe('PL-B shipment 09.10.2026.pdf')
  })

  it('describes a product by name alone when its Dimensions row is not a plain size', () => {
    expect(productDescription(CSC)).toBe('Compact Cutting Station')
    expect(productDescription(product('H8Mini', 'Echo Barrier H8 MINI', 1, 30, [['Dimensions', '( 1793 x 1010mm )']]))).toBe(
      'Echo Barrier H8 MINI (1793 x 1010 mm)',
    )
  })
})
