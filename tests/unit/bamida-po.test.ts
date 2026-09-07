import { describe, it, expect } from 'vitest'
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
