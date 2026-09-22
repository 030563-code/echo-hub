import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildBamidaPo, type BamidaSupplier } from '@/lib/bamida-po'
import type { SroPoBom, SroPoBomLine } from '@/lib/erp-types'

// Minimal SRO-PO fixture: one H9 line, 70 units (= 1 pallet), with master man/print costs.
function makePo(overrides: Partial<SroPoBomLine> = {}): SroPoBom {
  const line: SroPoBomLine = {
    sku: 'EBH9NA',
    product_name: 'Echo Barrier H9',
    quantity: 70,
    model_code: 'H9',
    has_bom: true,
    components: [],
    bamida_man_eur: 46.3,
    bamida_print_eur: 12.5,
    components_eur_unit: 0,
    bamida_total_line: 0,
    sro_total_line: 0,
    ...overrides,
  }
  return {
    id: 'po-1',
    po_number: 'PO-09999',
    master_ref: 'MR-PO-09999',
    from_entity: 'EB-GROUP',
    to_entity: 'EB-SRO',
    approved_at: null,
    created_at: '2026-06-24T00:00:00Z',
    lines: [line],
    bamida_total: 0,
    sro_total: 0,
  }
}

describe('buildBamidaPo', () => {
  it('passes a provided supplier straight through to the PO', () => {
    const supplier: BamidaSupplier = { name: 'Acme Mfg', address: ['1 Way', 'Town'], taxNumber: 'TAX1' }
    const po = buildBamidaPo(makePo(), '2026-06-24', supplier)
    expect(po.supplier).toEqual(supplier)
  })

  it('falls back to the default Bamida supplier when none is provided', () => {
    const po = buildBamidaPo(makePo(), '2026-06-24')
    expect(po.supplier.name).toBe('BAMIDA, s.r.o.')
    expect(po.supplier.address.length).toBeGreaterThan(0)
    expect(po.supplier.taxNumber).toBe('SK2022392372')
  })

  it('bills manufacturing + printing + per-pallet packaging with the right tax + totals', () => {
    const po = buildBamidaPo(makePo(), '2026-06-24')
    const codes = po.lines.map((l) => l.code)
    expect(codes).toEqual(['MANH9', 'PRISTD', 'Pallet COVERs', '1781'])

    const man = po.lines.find((l) => l.code === 'MANH9')!
    const print = po.lines.find((l) => l.code === 'PRISTD')!
    expect(man.taxRate).toBe(0)
    expect(man.amount).toBe(3241) // 70 × 46.30
    expect(print.taxRate).toBe(20)
    expect(print.amount).toBe(875) // 70 × 12.50

    expect(po.pallets).toBe(1) // ceil(70 / 70)
    expect(po.subtotal).toBe(4220) // 3241 + 875 + 19 + 85
    expect(po.tax).toBe(175) // 20% of 875
    expect(po.total).toBe(4395)
  })

  it('rounds pallets up for partial pallets (71 units of a 70-pack = 2 pallets)', () => {
    const po = buildBamidaPo(makePo({ quantity: 71 }), '2026-06-24')
    expect(po.pallets).toBe(2)
    const covers = po.lines.find((l) => l.code === 'Pallet COVERs')!
    expect(covers.qty).toBe(2)
  })
})

describe('the signed packing', () => {
  // EBSRO8001-1 as Martin saved it on 17 Sep 2026: 350 H9 make 5 pallets by the
  // table, but with a V2 and a cutting station on the order he signed 8 pallets,
  // 8 covers and 6 frames. The priced order said 7, 7 and 7 until 21 Sep.
  const signed = { pallets: 8, palletCovers: 8, metalFrames: 6 }

  it('prints the pallets, covers and frames somebody signed, not the ones the table makes', () => {
    const po = buildBamidaPo(makePo({ quantity: 350 }), '2026-06-24', undefined, 'EBSRO8001-1', signed)
    expect(po.pallets).toBe(8)
    expect(po.lines.find((l) => l.code === 'Pallet COVERs')!.qty).toBe(8)
    expect(po.lines.find((l) => l.code === '1781')!.qty).toBe(6)
    // 350 x 46.30 + 350 x 12.50 + 8 x 19 + 6 x 85
    expect(po.subtotal).toBe(16205 + 4375 + 152 + 510)
  })

  it('drops a packaging line whose signed count is zero rather than printing a zero line', () => {
    const po = buildBamidaPo(makePo(), '2026-06-24', undefined, null, { pallets: 1, palletCovers: 1, metalFrames: 0 })
    expect(po.lines.map((l) => l.code)).toEqual(['MANH9', 'PRISTD', 'Pallet COVERs'])
  })

  it('still counts from the pack sizes when nothing was saved', () => {
    const po = buildBamidaPo(makePo({ quantity: 71 }), '2026-06-24', undefined, null, null)
    expect(po.pallets).toBe(2)
    expect(po.lines.find((l) => l.code === '1781')!.qty).toBe(2)
  })
})

describe('every priced document reads the signed packing', () => {
  // Three places build the priced document. If any of them stops passing the
  // saved packing, that document silently goes back to the table's count and
  // disagrees with the -1 again, which is the fault Martin reported.
  const read = (path: string) => readFileSync(join(process.cwd(), path), 'utf8')

  it('the -3 download', () => {
    const src = read('src/lib/bamida-po-document.ts')
    expect(src).toContain('const packing = await specSavedPacking(poId)')
    expect(src).toContain('buildBamidaPo(bom, documentDate, supplier, number, packing)')
  })

  it('the bill of materials tab', () => {
    const src = read('src/app/(dashboard)/bom/page.tsx')
    expect(src).toContain('specSavedPackingBySroOrder(ids)')
    expect(src).toContain('packingBySro[po.id] ?? null')
  })

  it('the send to Bamida, whose email quotes the pallet count', () => {
    const src = read('src/app/actions/purchase-orders/send-manufacturing-po.ts')
    expect(src).toContain('const packing = await specSavedPacking(poId)')
    expect(src).toContain('supplier, po.po_number, packing)')
  })
})
