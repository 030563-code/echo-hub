import { describe, it, expect } from 'vitest'
import {
  asGroupCopy,
  buildPackingList,
  palletLoads,
  type PackingListParty,
  type PackingListProduct,
} from '@/lib/despatch/packing-list'
import {
  grossKg,
  netKg,
  PACK_WEIGHT,
  PALLET_TARE_KG,
  palletRef,
  toRoman,
  unitNetKgFor,
  WEIGHTS_CONFIRMED,
} from '@/lib/despatch/pack-weights'

/**
 * Four real Bamida packing lists, rebuilt from the Hub's own data.
 *
 * These are not invented fixtures. Each one was downloaded from the Monday.com
 * board on 21 Sep 2026 and its totals are what the document prints. If a weight
 * in PACK_WEIGHT is ever changed, these fail, which is the point: the table is
 * read off their documents and the documents are the only evidence we have.
 */

const SRO: PackingListParty = {
  name: 'ECHO BARRIER S.R.O.',
  address: ['Stúrová 3/6', '04001 Košice , Slovakia'],
  identifiers: ['VAT No. SK2023291600', 'ID:46241485'],
}
const GROUP: PackingListParty = {
  name: 'Echo Barrier Group Limited',
  address: ['41 Central Chambers', 'Dame Court', 'DUBLIN 2', 'IRELAND'],
  identifiers: ['Company Reg. No.: 616375'],
}
const PRESOV = ['Košická 26, 080 01', 'Prešov, Slovakia/EU']

const base = {
  variant: 'A' as const,
  issuer: SRO,
  date: '11/9/26',
  placeOfCollection: PRESOV,
  consignee: GROUP,
  deliverTo: GROUP,
  palletMonth: '2026-09',
  firstPalletNumber: 1,
}

describe('the weight arithmetic', () => {
  it('adds one tare per pallet and none to a loose item', () => {
    expect(PALLET_TARE_KG).toBe(50)
    expect(grossKg(385)).toBe(435)
    expect(grossKg(60, true)).toBe(60)
  })

  it('knows H9 is 5.0 kg without a mesh back and 5.5 kg with one', () => {
    expect(unitNetKgFor('H9', false)).toBe(5.0)
    expect(unitNetKgFor('H9', true)).toBe(5.5)
    // 175 kg on a 350-unit order, which is why the mesh is an input.
    expect(netKg(5.5, 350) - netKg(5.0, 350)).toBe(175)
  })

  it('returns null rather than guessing a model it has never weighed', () => {
    expect(unitNetKgFor('H27')).toBeNull()
    expect(unitNetKgFor(null)).toBeNull()
    expect(unitNetKgFor(undefined)).toBeNull()
  })

  it('carries HT3,5 at its exact value, not at the rounded one they print', () => {
    // Their own "weight per pc" column says 10 kg, but the pallet total is 325.
    expect(netKg(unitNetKgFor('HT3,5')!, 30)).toBe(325)
  })

  it('stays unconfirmed until somebody signs the table off', () => {
    expect(WEIGHTS_CONFIRMED).toBe(false)
    expect(buildPackingList({ ...base, products: [], signedPallets: null }).weightsConfirmed).toBe(false)
  })

  it('names the document every figure was read off', () => {
    for (const [model, row] of Object.entries(PACK_WEIGHT)) {
      expect(row.source, `${model} has no source`).toBeTruthy()
      expect(row.unitNetKg).toBeGreaterThan(0)
    }
  })
})

describe('pallet references', () => {
  it('counts in roman numerals the way they write them', () => {
    expect(toRoman(1)).toBe('I')
    expect(toRoman(4)).toBe('IV')
    expect(toRoman(9)).toBe('IX')
    expect(toRoman(15)).toBe('XV')
    expect(toRoman(24)).toBe('XXIV')
    expect(toRoman(31)).toBe('XXXI')
    expect(toRoman(0)).toBe('')
  })

  it('prints the reference exactly as the documents do', () => {
    expect(palletRef('2026-09', 17)).toBe('(2026/09/XVII)')
    expect(palletRef('2026-07', 24)).toBe('(2026/07/XXIV)')
  })
})

describe('splitting a quantity into pallets', () => {
  it('makes whole pallets and one remainder', () => {
    expect(palletLoads(420, 70)).toEqual([70, 70, 70, 70, 70, 70])
    expect(palletLoads(75, 70)).toEqual([70, 5])
    expect(palletLoads(5, 5)).toEqual([5])
    expect(palletLoads(0, 70)).toEqual([])
  })

  it('weighs a remainder pallet by what is on it, not by a full one', () => {
    const doc = buildPackingList({
      ...base,
      products: [{ model: 'H9', description: 'Echo Barrier H9', quantity: 75, packSize: 70, hasMesh: true }],
      signedPallets: 2,
    })
    expect(doc.pallets.map((p) => p.netKg)).toEqual([385, 27.5])
    expect(doc.totalNetKg).toBe(412.5)
  })
})

describe('the four real documents', () => {
  it('reproduces PL-A USA Jessup 11.09.2026 (EBG26100)', () => {
    // 6 pallets of 70 H9, one of 5 CS R10, one of 5 R10 frames, one loose CSC frame.
    const doc = buildPackingList({
      ...base,
      products: [
        { model: 'H9', description: 'Echo Barrier H9 (1335 x 2050 mm)', quantity: 420, packSize: 70, hasMesh: true },
        { model: 'CS R10', description: 'CS Cutting Station R10', quantity: 5, packSize: 5 },
        { model: 'CS R10 Frame', description: 'CS Cutting Station R10 Frames', quantity: 5, packSize: 5 },
      ],
      signedPallets: 8,
      firstPalletNumber: 17,
      palletMonth: '2026-09',
    })
    // The eight pallets they printed, before the loose frame is added by hand.
    expect(doc.pallets.map((p) => p.ref)).toEqual([
      '(2026/09/XVII)', '(2026/09/XVIII)', '(2026/09/XIX)', '(2026/09/XX)',
      '(2026/09/XXI)', '(2026/09/XXII)', '(2026/09/XXIII)', '(2026/09/XXIV)',
    ])
    expect(doc.pallets.slice(0, 6).every((p) => p.netKg === 385 && p.grossKg === 435)).toBe(true)
    expect(doc.pallets[6]).toMatchObject({ netKg: 400, grossKg: 450 })
    expect(doc.pallets[7]).toMatchObject({ netKg: 430, grossKg: 480 })
    // With the loose frame the document totals 3,200 / 3,600.
    const withLoose = buildPackingList({
      ...base,
      products: [],
      signedPallets: 8,
      palletsOverride: [
        ...doc.pallets,
        { ref: '', description: 'Frame (CS CSC Frame = 1 pcs)', packingSize: 'loosely laid', netKg: 60, grossKg: 60, loose: true },
      ],
    })
    expect(withLoose.totalNetKg).toBe(3200)
    expect(withLoose.totalGrossKg).toBe(3600)
    expect(withLoose.units).toBe(8)
  })

  it('reproduces PL-A CAN Ontario 17.07.2026 (EBG26071), the no-mesh H9', () => {
    const doc = buildPackingList({
      ...base,
      products: [
        { model: 'H9', description: 'Echo Barrier H9 Series Barrier (1335 x 2050 mm)', quantity: 560, packSize: 70, hasMesh: false },
      ],
      signedPallets: 8,
      firstPalletNumber: 24,
      palletMonth: '2026-07',
    })
    expect(doc.pallets).toHaveLength(8)
    expect(doc.pallets.every((p) => p.netKg === 350 && p.grossKg === 400)).toBe(true)
    expect(doc.totalNetKg).toBe(2800)
    expect(doc.totalGrossKg).toBe(3200)
    expect(doc.pallets[0].ref).toBe('(2026/07/XXIV)')
    expect(doc.pallets[7].ref).toBe('(2026/07/XXXI)')
  })

  it('reproduces PL-A France 08.07.2026 (EBG26074), mixed models', () => {
    const doc = buildPackingList({
      ...base,
      products: [
        { model: 'HT3,5', description: 'HT3.5 SERIES BARRIER (3650 x 2050mm)', quantity: 120, packSize: 30 },
        { model: 'H9', description: 'Echo Barrier H9 SERIES BARRIER (1335 x 2050mm)', quantity: 280, packSize: 70, hasMesh: true },
      ],
      signedPallets: 9,
      firstPalletNumber: 15,
      palletMonth: '2026-07',
    })
    expect(doc.pallets.slice(0, 4).every((p) => p.netKg === 325 && p.grossKg === 375)).toBe(true)
    expect(doc.pallets.slice(4, 8).every((p) => p.netKg === 385 && p.grossKg === 435)).toBe(true)
    // Their ninth pallet carried one cutting station and one frame together.
    const combined = buildPackingList({
      ...base,
      products: [],
      signedPallets: 9,
      palletsOverride: [
        ...doc.pallets,
        { ref: '(2026/07/XXIII)', description: 'Acoustic barriers (CS R10 = 1 pc(80kg)) + Frame (86kg)', packingSize: '210 x 140 x 120 cm', netKg: 166, grossKg: 216, loose: false },
      ],
    })
    expect(combined.totalNetKg).toBe(3006)
    expect(combined.totalGrossKg).toBe(3456)
    expect(combined.units).toBe(9)
  })

  it('reproduces PL-A UK 10.08.2026, four purchase orders on one container', () => {
    const doc = buildPackingList({
      ...base,
      products: [
        { model: 'H8', description: 'Echo Barrier H8 (3650x2050mm)', quantity: 30, packSize: 30, poReference: 'EBG26083' },
        { model: 'ND RT-100', description: 'Echo Barrier ND RT100 (3650x2050mm)', quantity: 60, packSize: 30, poReference: 'EBG26066' },
        { model: 'H9', description: 'Echo Barrier H9 (1335x2050mm)', quantity: 420, packSize: 70, hasMesh: true, poReference: 'EBG26091, EBG26094' },
      ],
      signedPallets: 9,
      firstPalletNumber: 1,
      palletMonth: '2026-08',
    })
    expect(doc.pallets.slice(0, 3).every((p) => p.netKg === 300 && p.grossKg === 350)).toBe(true)
    expect(doc.pallets.slice(3, 9).every((p) => p.netKg === 385 && p.grossKg === 435)).toBe(true)
    expect(doc.totalNetKg).toBe(3210)
    expect(doc.totalGrossKg).toBe(3660)
    expect(doc.units).toBe(9)
    // A container can carry several orders, and every one stays on the document.
    expect(doc.lines.map((l) => l.poReference)).toEqual(['EBG26083', 'EBG26066', 'EBG26091, EBG26094'])
  })
})

describe('the signed pallet count', () => {
  it('prints the signed count and says so when the products disagree', () => {
    // The live order EBSRO8001-1: Juraj signed 8, the three products make 7.
    const doc = buildPackingList({
      ...base,
      products: [
        { model: 'H9', description: 'Echo Barrier H9', quantity: 350, packSize: 70, hasMesh: true },
        { model: 'V2', description: 'Echo Barrier V2', quantity: 5, packSize: 5 },
        { model: 'CSCompact', description: 'Compact Cutting Station', quantity: 5, packSize: 5 },
      ],
      signedPallets: 8,
    })
    expect(doc.pallets).toHaveLength(7)
    expect(doc.units).toBe(8)
    expect(doc.warnings.some((w) => w.includes('says 8 pallets and the products make 7'))).toBe(true)
  })

  it('falls back to the computed count when nothing has been signed', () => {
    const doc = buildPackingList({
      ...base,
      products: [{ model: 'H9', description: 'H9', quantity: 140, packSize: 70, hasMesh: true }],
      signedPallets: null,
    })
    expect(doc.units).toBe(2)
    expect(doc.warnings.some((w) => w.includes('pallets and the products make'))).toBe(false)
  })

  it('does not count a loose item as a unit', () => {
    const doc = buildPackingList({
      ...base,
      products: [],
      signedPallets: null,
      palletsOverride: [
        { ref: '(2026/09/I)', description: 'p', packingSize: 'x', netKg: 385, grossKg: 435, loose: false },
        { ref: '', description: 'frame', packingSize: 'loosely laid', netKg: 60, grossKg: 60, loose: true },
      ],
    })
    expect(doc.units).toBe(1)
    expect(doc.totalGrossKg).toBe(495)
  })
})

describe('what the builder refuses to guess', () => {
  it('warns rather than inventing a weight for a model it does not hold', () => {
    const doc = buildPackingList({
      ...base,
      products: [{ model: 'H27', description: 'Echo Barrier H27', quantity: 70, packSize: 70, hsCode: '3925.90.0000' }],
      signedPallets: 1,
    })
    expect(doc.lines[0].unitNetKg).toBeNull()
    expect(doc.pallets[0].netKg).toBe(0)
    expect(doc.warnings.some((w) => w.includes('No weight held for H27'))).toBe(true)
  })

  it('warns on a line with no HS code, because the document crosses a border', () => {
    const doc = buildPackingList({
      ...base,
      products: [{ model: 'H9', description: 'H9', quantity: 70, packSize: 70, hasMesh: true }],
      signedPallets: 1,
    })
    expect(doc.warnings.some((w) => w.includes('No HS code for H9'))).toBe(true)
  })
})

describe('the two copies', () => {
  const products: PackingListProduct[] = [
    { model: 'H9', description: 'Echo Barrier H9 (1335 x 2050 mm)', quantity: 420, packSize: 70, hasMesh: true, hsCode: '3925.90.0000' },
  ]
  const a = buildPackingList({ ...base, products, signedPallets: 6, firstPalletNumber: 17 })
  const b = asGroupCopy(a, {
    issuer: GROUP,
    consignee: { name: 'Echo Barrier USA Head Office', address: ['33 North Dearborn, Suite 1000', 'Chicago', 'IL 60602', 'USA'] },
  })

  it('differ only in the letterhead and the consignee', () => {
    expect(b.variant).toBe('B')
    expect(b.issuer.name).toBe('Echo Barrier Group Limited')
    expect(b.consignee.name).toBe('Echo Barrier USA Head Office')
    expect(a.issuer.name).toBe('ECHO BARRIER S.R.O.')
  })

  it('carry byte-identical pallets, weights and totals', () => {
    // The one failure this module exists to prevent.
    expect(b.pallets).toEqual(a.pallets)
    expect(b.totalNetKg).toBe(a.totalNetKg)
    expect(b.totalGrossKg).toBe(a.totalGrossKg)
    expect(b.units).toBe(a.units)
    expect(b.lines).toEqual(a.lines)
  })
})
