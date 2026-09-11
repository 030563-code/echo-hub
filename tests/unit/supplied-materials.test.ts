import { describe, it, expect } from 'vitest'
import {
  SUPPLIED_CHARGE_CODES,
  suppliedRequirement,
  suppliedShortagesFor,
  type SuppliedBomRow,
} from '@/lib/mrp/supplied-materials'

const BOM: SuppliedBomRow[] = [
  { finished_sku: 'EBH9NA', component_code: 'PC350FR-UV21', component_desc: 'PC350 FR UV 2.1 wide', qty_per: 2.85 },
  { finished_sku: 'EBH9NA', component_code: 'ACI-T40', component_desc: 'Senizol T40', qty_per: 8 },
  { finished_sku: 'EBH9NA', component_code: 'DAT-01', component_desc: 'Datatag', qty_per: 1 },
  { finished_sku: 'EBH9NA', component_code: 'GRP-SLTF', component_desc: 'Group slitting fee', qty_per: 1 },
  { finished_sku: 'EBH9NA', component_code: 'ACI-TRNS', component_desc: 'Transport infill', qty_per: 8 },
  { finished_sku: 'EBH8NA', component_code: 'PC350FR-UV21', component_desc: 'PC350 FR UV 2.1 wide', qty_per: 9.3 },
]

describe('SUPPLIED_CHARGE_CODES', () => {
  it('names the four rows that are charges, not stock', () => {
    expect([...SUPPLIED_CHARGE_CODES].sort()).toEqual(['ACI-TRNS', 'ACI-TRNS-OP', 'GRP-SLTF', 'PC350FR-TRNS'])
  })
})

describe('suppliedRequirement', () => {
  it('is qty_per times quantity, charge codes dropped, other skus ignored', () => {
    const need = suppliedRequirement(BOM, 'EBH9NA', 10)
    expect([...need.entries()]).toEqual([
      ['PC350FR-UV21', 28.5],
      ['ACI-T40', 80],
      ['DAT-01', 10],
    ])
  })

  it('is empty for zero quantity or an unknown sku', () => {
    expect(suppliedRequirement(BOM, 'EBH9NA', 0).size).toBe(0)
    expect(suppliedRequirement(BOM, 'NOPE', 10).size).toBe(0)
  })
})

describe('suppliedShortagesFor', () => {
  const stock = new Map([
    ['PC350FR-UV21', 20],
    ['ACI-T40', 500],
    // DAT-01 deliberately absent: no stock card.
  ])

  it('reports the short components worst first and the unjoined ones separately', () => {
    const { shortages, unjoined } = suppliedShortagesFor(BOM, stock, 'EBH9NA', 10)
    expect(shortages).toEqual([
      { code: 'PC350FR-UV21', description: 'PC350 FR UV 2.1 wide', need: 28.5, have: 20, short: 8.5 },
    ])
    // Unknown is not zero: DAT-01 is not in the shortage list.
    expect(unjoined).toEqual(['DAT-01'])
  })

  it('says nothing is short when stock covers the order', () => {
    const { shortages } = suppliedShortagesFor(BOM, stock, 'EBH9NA', 5)
    expect(shortages).toEqual([])
  })

  it('clamps a negative level to zero rather than inflating the short', () => {
    const negative = new Map([['PC350FR-UV21', -50]])
    const { shortages } = suppliedShortagesFor(BOM, negative, 'EBH9NA', 1)
    expect(shortages[0]).toMatchObject({ have: 0, short: 2.85 })
  })
})
