import { describe, it, expect } from 'vitest'
import {
  stripBamidaPo,
  stripBomMasterCosts,
  stripPurchaseOrderCosts,
  stripSroPoBomCosts,
} from '@/lib/price-visibility'
import { buildBamidaPo } from '@/lib/bamida-po'
import type { BomMasterRow, PurchaseOrder, SroPoBom, SroPoBomLine } from '@/lib/erp-types'

function makeSroPo(): SroPoBom {
  const line: SroPoBomLine = {
    sku: 'EBH9NA',
    product_name: 'Echo Barrier H9',
    quantity: 70,
    model_code: 'H9',
    has_bom: true,
    components: [
      { code: 'PC350FR GR6', desc: 'Goretex', qty: 2, currency: 'EUR', dutiable: true, unit_cost_eur: 10, extended_eur: 20, line_qty: 140, line_extended_eur: 1400 },
    ],
    bamida_man_eur: 46.3,
    bamida_print_eur: 12.5,
    components_eur_unit: 20,
    bamida_total_line: 5000,
    sro_total_line: 4000,
  }
  return {
    id: 'po-1', po_number: 'PO-09999', master_ref: 'MR', from_entity: 'EB-GROUP', to_entity: 'EB-SRO',
    approved_at: null, created_at: '2026-06-24T00:00:00Z', lines: [line], bamida_total: 5000, sro_total: 4000,
  }
}

describe('price-visibility stripping', () => {
  it('stripPurchaseOrderCosts nulls unit_price only when cost is hidden', () => {
    const orders = [{ id: 'p', lines: [{ id: 'l', unit_price: 12.5 }] }] as unknown as PurchaseOrder[]
    expect(stripPurchaseOrderCosts(orders, true)[0].lines![0].unit_price).toBe(12.5)
    expect(stripPurchaseOrderCosts(orders, false)[0].lines![0].unit_price).toBeNull()
  })

  it('stripSroPoBomCosts zeros every EUR figure when hidden, passes through when allowed', () => {
    const po = makeSroPo()
    expect(stripSroPoBomCosts(po, true)).toBe(po) // identity when allowed
    const s = stripSroPoBomCosts(po, false)
    expect(s.bamida_total).toBe(0)
    expect(s.sro_total).toBe(0)
    expect(s.lines[0].bamida_man_eur).toBe(0)
    expect(s.lines[0].bamida_print_eur).toBe(0)
    expect(s.lines[0].bamida_total_line).toBe(0)
    expect(s.lines[0].sro_total_line).toBe(0)
    expect(s.lines[0].components[0].unit_cost_eur).toBe(0)
    expect(s.lines[0].components[0].line_extended_eur).toBe(0)
    // non-cost fields survive
    expect(s.lines[0].quantity).toBe(70)
    expect(s.lines[0].components[0].code).toBe('PC350FR GR6')
    expect(s.lines[0].components[0].line_qty).toBe(140)
  })

  it('stripBomMasterCosts nulls master costs but keeps structure', () => {
    const rows = [{
      model_code: 'H9', product_line: 'H9', week_start_date: '2026-06-08',
      bamida_man_eur: 46.3, bamida_print_eur: 12.5, bamida_total_eur: 58.8,
      sro_components_eur: 1, sro_duty_8pct_eur: 1, sro_admin_eur: 1, sro_total_eur: 3,
      bom_total_eur: 61.8, fx_gbp_eur: 0.85, bom_change_pct: 0,
      component_detail: [{ code: 'X', desc: null, qty: 1, currency: 'EUR', dutiable: false, unit_cost_eur: 5, extended_eur: 5 }],
    }] as BomMasterRow[]
    const s = stripBomMasterCosts(rows, false)
    expect(s[0].bom_total_eur).toBeNull()
    expect(s[0].bamida_total_eur).toBeNull()
    expect(s[0].sro_total_eur).toBeNull()
    expect(s[0].fx_gbp_eur).toBeNull()
    expect(s[0].component_detail[0].unit_cost_eur).toBe(0)
    expect(s[0].component_detail[0].code).toBe('X') // structure kept
    expect(stripBomMasterCosts(rows, true)).toBe(rows) // identity when allowed
  })

  it('stripBamidaPo produces a price-less BOM PO (lines kept, money gone, priced=false)', () => {
    const full = buildBamidaPo(makeSroPo(), '2026-06-24')
    expect(full.priced).toBe(true)
    expect(full.total).not.toBeNull()

    const bom = stripBamidaPo(full)
    expect(bom.priced).toBe(false)
    expect(bom.subtotal).toBeNull()
    expect(bom.tax).toBeNull()
    expect(bom.total).toBeNull()
    // lines survive (the manufacturer needs the spec), money nulled
    expect(bom.lines.length).toBe(full.lines.length)
    expect(bom.lines.every((l) => l.price === null && l.amount === null && l.taxRate === null)).toBe(true)
    expect(bom.lines[0].code).toBe(full.lines[0].code)
    expect(bom.lines[0].qty).toBe(full.lines[0].qty)
  })
})
