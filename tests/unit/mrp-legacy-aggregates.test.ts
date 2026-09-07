import { describe, it, expect } from 'vitest'
import { netOnOrderBySku, sumReceiptsByLine, sumStockBySku } from '@/lib/mrp/legacy-aggregates'

describe('sumStockBySku', () => {
  it('SUMS a sku across depots instead of keeping the last row', () => {
    // warehouse_stock_levels is one row per (warehouse, sku); EBH9NA lives in 3.
    const rows = [
      { sku: 'EBH9NA', product_name: 'H9 Barrier', quantity_on_hand: 12 },
      { sku: 'EBH9NA', product_name: 'H9 Barrier', quantity_on_hand: 30 },
      { sku: 'EBH9NA', product_name: 'H9 Barrier', quantity_on_hand: 5 },
      { sku: 'EBH10NA', product_name: 'H10 Barrier', quantity_on_hand: 7 },
    ]
    const out = sumStockBySku(rows)
    expect(out.get('EBH9NA')).toEqual({ product_name: 'H9 Barrier', in_stock: 47 })
    expect(out.get('EBH10NA')).toEqual({ product_name: 'H10 Barrier', in_stock: 7 })
  })

  it('does not let a trailing zero-qty depot row erase a real holding', () => {
    // The regression: `.set()` over an unordered select kept whichever row came
    // last, so a 0 in the final depot would display as "In Stock: 0".
    const out = sumStockBySku([
      { sku: 'EBH9NA', product_name: 'H9 Barrier', quantity_on_hand: 40 },
      { sku: 'EBH9NA', product_name: 'H9 Barrier', quantity_on_hand: 0 },
    ])
    expect(out.get('EBH9NA')?.in_stock).toBe(40)
  })

  it('keeps the first non-null product_name', () => {
    const out = sumStockBySku([
      { sku: 'EBH9NA', product_name: null, quantity_on_hand: 1 },
      { sku: 'EBH9NA', product_name: 'H9 Barrier', quantity_on_hand: 2 },
    ])
    expect(out.get('EBH9NA')).toEqual({ product_name: 'H9 Barrier', in_stock: 3 })
  })

  it('returns an empty map for no rows', () => {
    expect(sumStockBySku([]).size).toBe(0)
  })
})

describe('sumReceiptsByLine', () => {
  it('sums multiple partial batches per line', () => {
    const out = sumReceiptsByLine([
      { po_line_id: 'l1', qty_received: 30 },
      { po_line_id: 'l1', qty_received: 20 },
      { po_line_id: 'l2', qty_received: 5 },
    ])
    expect(out.get('l1')).toBe(50)
    expect(out.get('l2')).toBe(5)
  })
})

describe('netOnOrderBySku', () => {
  it('subtracts received qty so a partial receipt is not double-counted', () => {
    // 100 ordered, 40 already landed (and already added to in_stock by
    // recordReceipt) -> only 60 is still genuinely on order.
    const pos = [{ lines: [{ id: 'l1', sku: 'EBH9NA', quantity: 100 }] }]
    const out = netOnOrderBySku(pos, new Map([['l1', 40]]))
    expect(out.get('EBH9NA')).toBe(60)
  })

  it('drops a fully received line to zero rather than counting it twice', () => {
    const pos = [{ lines: [{ id: 'l1', sku: 'EBH9NA', quantity: 100 }] }]
    const out = netOnOrderBySku(pos, new Map([['l1', 100]]))
    expect(out.get('EBH9NA')).toBeUndefined()
  })

  it('is unchanged from the gross total when nothing has been received', () => {
    const pos = [
      { lines: [{ id: 'l1', sku: 'EBH9NA', quantity: 100 }] },
      { lines: [{ id: 'l2', sku: 'EBH9NA', quantity: 25 }] },
    ]
    expect(netOnOrderBySku(pos, new Map()).get('EBH9NA')).toBe(125)
  })

  it('floors per line so an over-receipt cannot borrow from another line', () => {
    // l1 over-received by 20 (the po_line_receipt_guard trigger rejects this,
    // but the floor keeps l2's outstanding 50 intact regardless).
    const pos = [
      { lines: [{ id: 'l1', sku: 'EBH9NA', quantity: 100 }] },
      { lines: [{ id: 'l2', sku: 'EBH9NA', quantity: 50 }] },
    ]
    const out = netOnOrderBySku(pos, new Map([['l1', 120]]))
    expect(out.get('EBH9NA')).toBe(50)
  })

  it('aggregates net outstanding across POs and skus', () => {
    const pos = [
      {
        lines: [
          { id: 'l1', sku: 'EBH9NA', quantity: 100 },
          { id: 'l2', sku: 'EBH10NA', quantity: 40 },
        ],
      },
      { lines: [{ id: 'l3', sku: 'EBH9NA', quantity: 60 }] },
    ]
    const out = netOnOrderBySku(pos, new Map([['l1', 30], ['l3', 60]]))
    expect(out.get('EBH9NA')).toBe(70) // (100-30) + (60-60)
    expect(out.get('EBH10NA')).toBe(40)
  })

  it('tolerates a PO with null lines', () => {
    expect(netOnOrderBySku([{ lines: null }], new Map()).size).toBe(0)
  })
})

describe('cip is no longer optimistic (integration of both helpers)', () => {
  it('counts a partially received unit once, not twice', () => {
    // 100 ordered; 40 received -> recordReceipt already pushed 40 into the
    // depot's warehouse_stock_levels row. Gross-ordered math gave
    // cip = 40 + 0 + 100 = 140 for 100 real units.
    const stock = sumStockBySku([
      { sku: 'EBH9NA', product_name: 'H9 Barrier', quantity_on_hand: 40 },
    ])
    const ordered = netOnOrderBySku(
      [{ lines: [{ id: 'l1', sku: 'EBH9NA', quantity: 100 }] }],
      new Map([['l1', 40]]),
    )
    const inStock = stock.get('EBH9NA')!.in_stock
    const cip = inStock + 0 + (ordered.get('EBH9NA') ?? 0)
    expect(cip).toBe(100)
  })
})
