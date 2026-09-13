import { describe, it, expect } from 'vitest'
import { findLedgerGaps, type ReconcileInputs } from '@/lib/stock/reconcile'

const none: ReconcileInputs = {
  invoices: [],
  bookedSroOrders: [],
  finishedBamidaOrders: [],
  receipts: [],
  movements: [],
}

describe('findLedgerGaps', () => {
  it('is empty when every event has its movement', () => {
    const gaps = findLedgerGaps({
      ...none,
      invoices: [{ id: 'inv1', invoice_number: 'EBUS2026001', status: 'sent', has_goods_lines: true, since: '2026-09-01' }],
      bookedSroOrders: [{ id: 'sro1', po_number: 'PO-01177', spot_id: '236', since: '2026-09-02' }],
      finishedBamidaOrders: [{ id: 'bam1', po_number: 'PO-01178', finished_at: '2026-09-03' }],
      receipts: [{ id: 'rc1', po_number: 'PO-01174', sku: 'EBH9NA', qty_received: 10, received_at: '2026-09-04' }],
      movements: [
        { kind: 'customer_dispatch', ref_type: 'customer_invoice', ref_id: 'inv1' },
        { kind: 'shipped_out', ref_type: 'po_shipment', ref_id: 'sro1' },
        { kind: 'manufactured', ref_type: 'po_manufacturing', ref_id: 'bam1' },
        { kind: 'receipt', ref_type: 'po_line_receipt', ref_id: 'rc1' },
      ],
    })
    expect(gaps).toEqual([])
  })

  it('names each missing movement with its cause, oldest first', () => {
    const gaps = findLedgerGaps({
      ...none,
      invoices: [{ id: 'inv1', invoice_number: 'EBUS2026001', status: 'completed', has_goods_lines: true, since: '2026-09-05' }],
      bookedSroOrders: [{ id: 'sro1', po_number: 'PO-01177', spot_id: '236', since: '2026-09-01' }],
      finishedBamidaOrders: [{ id: 'bam1', po_number: 'PO-01178', finished_at: '2026-09-03' }],
      receipts: [{ id: 'rc1', po_number: 'PO-01174', sku: 'EBH9NA', qty_received: 10, received_at: '2026-09-04' }],
    })
    expect(gaps.map((g) => [g.kind, g.ref_id])).toEqual([
      ['shipped_out', 'sro1'],
      ['manufactured', 'bam1'],
      ['receipt', 'rc1'],
      ['customer_dispatch', 'inv1'],
    ])
    expect(gaps[0].label).toBe('PO-01177 booked (SPOT 236) with nothing deducted at s.r.o.')
    expect(gaps[0].href).toBe('/purchase-orders/sro1')
    expect(gaps[2].label).toBe('Receipt of 10 EBH9NA on PO-01174 not on the ledger')
    expect(gaps[3].label).toBe('Invoice EBUS2026001 is completed with no dispatch recorded')
  })

  it('ignores an invoice of freight only: nothing to move', () => {
    const gaps = findLedgerGaps({
      ...none,
      invoices: [{ id: 'inv2', invoice_number: 'EBUS2026002', status: 'sent', has_goods_lines: false, since: '2026-09-05' }],
    })
    expect(gaps).toEqual([])
  })

  it('matches on kind and ref together: a count against the same id is not a dispatch', () => {
    const gaps = findLedgerGaps({
      ...none,
      invoices: [{ id: 'inv1', invoice_number: null, status: 'sent', has_goods_lines: true, since: null }],
      movements: [{ kind: 'adjustment', ref_type: 'customer_invoice', ref_id: 'inv1' }],
    })
    expect(gaps).toHaveLength(1)
    expect(gaps[0].label).toBe('Invoice inv1 is sent with no dispatch recorded')
  })
})
