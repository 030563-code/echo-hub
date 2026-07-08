import { describe, it, expect } from 'vitest'
import { buildCommercialInvoice, commercialInvoiceDocFromRecord, type BuildCommercialInvoiceInput } from '@/lib/commercial-invoice'
import { stripCommercialInvoice } from '@/lib/price-visibility'

const base: BuildCommercialInvoiceInput = {
  invoice_number: 'EBGS2026-00001',
  date: '2026-06-25',
  leg: 'SRO_TO_GROUP',
  seller: { code: 'EB-SRO', legal_name: 'Echo Barrier s.r.o.', address_lines: ['Sturova 3/6', 'Kosice'], vat_tax_id: 'SK2023291600' },
  buyer: { code: 'EB-GROUP', legal_name: 'Echo Barrier Group Limited', address_lines: ['—'], vat_tax_id: null },
  container_ref: 'CMAU6783741',
  spot_id: '236467395',
  po_reference: 'EBG25112',
  currency: 'EUR',
  lines: [
    { sku: 'EBH9NA', product_name: 'Echo Barrier H9', qty: 400, unit_value: 27.01, hs_code: null },
    { sku: 'EBH10NA', product_name: 'Echo Barrier H10', qty: 100, unit_value: 25.68, hs_code: null },
  ],
}

describe('buildCommercialInvoice', () => {
  it('computes line totals, subtotal and total (0-rated tax)', () => {
    const doc = buildCommercialInvoice(base)
    expect(doc.lines[0].line_total).toBe(10804) // 400 * 27.01
    expect(doc.lines[1].line_total).toBe(2568) // 100 * 25.68
    expect(doc.subtotal).toBe(13372)
    expect(doc.tax_total).toBe(0)
    expect(doc.total).toBe(13372)
    expect(doc.priced).toBe(true)
    expect(doc.fx).toBeNull()
  })

  it('rounds unit value first, then derives line total from the rounded value', () => {
    const doc = buildCommercialInvoice({ ...base, lines: [{ sku: 'X', product_name: 'X', qty: 3, unit_value: 1.114, hs_code: null }] })
    expect(doc.lines[0].unit_value).toBe(1.11) // round2(1.114)
    expect(doc.lines[0].line_total).toBe(3.33) // round2(3 * 1.11) — unit_value × qty stays consistent
  })

  it('carries the FX block through when supplied (USD leg)', () => {
    const doc = buildCommercialInvoice({ ...base, currency: 'USD', fx: { pair: 'EUR_USD', rate: 1.1643, method: 'rolling_13w', week_start: '2026-03-23' } })
    expect(doc.fx).toEqual({ pair: 'EUR_USD', rate: 1.1643, method: 'rolling_13w', week_start: '2026-03-23' })
  })
})

describe('commercialInvoiceDocFromRecord', () => {
  const seller = { code: 'EB-SRO', legal_name: 'Echo Barrier s.r.o.', address_lines: ['Kosice'], vat_tax_id: 'SK2023291600' }
  const buyer = { code: 'EB-USA', legal_name: 'Echo Barrier USA LLC', address_lines: ['—'], vat_tax_id: null }

  it('rebuilds from STORED (string) numerics + the FX block, without recomputing', () => {
    const doc = commercialInvoiceDocFromRecord({
      invoice_number: 'EBGS2026-00002', date: '2026-06-25', leg: 'GROUP_TO_USA', currency: 'USD',
      container_ref: 'CMAU1', spot_id: 's1', po_reference: 'p1',
      subtotal: '314.50', tax_total: '0', total: '314.50',
      fx_pair: 'EUR_USD', fx_rate: '1.1648', fx_method: 'rolling_13w', fx_week_start: '2026-03-23',
      seller, buyer,
      lines: [{ sku: 'EBH9NA', product_name: 'H9', qty: '10', unit_value: '31.45', line_total: '314.50', hs_code: null }],
    })
    expect(doc.total).toBe(314.5)
    expect(doc.lines[0].qty).toBe(10)
    expect(doc.lines[0].unit_value).toBe(31.45)
    expect(doc.fx).toEqual({ pair: 'EUR_USD', rate: 1.1648, method: 'rolling_13w', week_start: '2026-03-23' })
    expect(doc.priced).toBe(true)
  })

  it('has no FX block on the EUR leg (fx_rate null), and strips for a non-cost viewer', () => {
    const doc = commercialInvoiceDocFromRecord({
      invoice_number: 'EBGS2026-00001', date: '2026-06-25', leg: 'SRO_TO_GROUP', currency: 'EUR',
      container_ref: 'CMAU1', spot_id: null, po_reference: null,
      subtotal: '270.10', tax_total: '0', total: '270.10',
      fx_pair: null, fx_rate: null, fx_method: null, fx_week_start: null,
      seller, buyer,
      lines: [{ sku: 'EBH9NA', product_name: 'H9', qty: 10, unit_value: 27.01, line_total: 270.1, hs_code: null }],
    })
    expect(doc.fx).toBeNull()
    expect(doc.total).toBe(270.1)
    const stripped = stripCommercialInvoice(doc)
    expect(stripped.total).toBeNull()
    expect(stripped.lines[0].unit_value).toBeNull()
    expect(stripped.lines[0].qty).toBe(10) // manifest preserved
  })
})

describe('stripCommercialInvoice', () => {
  it('nulls every value + the FX block and flips priced false', () => {
    const doc = buildCommercialInvoice({ ...base, currency: 'USD', fx: { pair: 'EUR_USD', rate: 1.16, method: 'rolling_13w', week_start: null } })
    const stripped = stripCommercialInvoice(doc)
    expect(stripped.priced).toBe(false)
    expect(stripped.subtotal).toBeNull()
    expect(stripped.tax_total).toBeNull()
    expect(stripped.total).toBeNull()
    expect(stripped.fx).toBeNull()
    expect(stripped.lines.every((l) => l.unit_value === null && l.line_total === null)).toBe(true)
    // SKU/qty are preserved (the buyer still needs the manifest).
    expect(stripped.lines[0].sku).toBe('EBH9NA')
    expect(stripped.lines[0].qty).toBe(400)
  })
})
