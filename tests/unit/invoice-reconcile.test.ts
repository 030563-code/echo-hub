import { describe, it, expect } from 'vitest'
import { reconcileInvoiceLines } from '@/lib/commercial-invoice'

describe('reconcileInvoiceLines (editable-draft override)', () => {
  it('rounds unit_value first, derives line_total, and sums the subtotal/total', () => {
    const r = reconcileInvoiceLines([
      { sku: 'A', product_name: 'A', qty: 10, unit_value: 108, hs_code: null },
      { sku: 'B', product_name: 'B', qty: 2, unit_value: 50.005, hs_code: 'X' },
    ])
    expect(r.lines[0].line_total).toBe(1080)
    expect(r.lines[1].unit_value).toBe(50.01) // rounded FIRST
    expect(r.lines[1].line_total).toBe(100.02) // 2 × 50.01
    expect(r.subtotal).toBe(1180.02)
    expect(r.total).toBe(1180.02)
  })

  it('carries tax through to the total', () => {
    const r = reconcileInvoiceLines([{ sku: 'A', product_name: 'A', qty: 1, unit_value: 100, hs_code: null }], 20)
    expect(r.subtotal).toBe(100)
    expect(r.tax_total).toBe(20)
    expect(r.total).toBe(120)
  })

  it('a consolidation override (fewer lines, bundled price) still reconciles', () => {
    // H9 bundled to 108 after folding in packing+shipping; one line out.
    const r = reconcileInvoiceLines([{ sku: 'EBH9NA', product_name: 'H9', qty: 10, unit_value: 108, hs_code: '6306' }])
    expect(r.lines).toHaveLength(1)
    expect(r.total).toBe(1080)
  })
})
