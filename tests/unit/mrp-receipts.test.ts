import { describe, it, expect } from 'vitest'
import { buildStockIncrements } from '@/lib/mrp/receipts'

describe('buildStockIncrements', () => {
  it('aggregates received qtys per sku for the receiving depot', () => {
    const poLines = new Map([
      ['l1', { id: 'l1', sku: 'EBH9NA', quantity: 100 }],
      ['l2', { id: 'l2', sku: 'EBH10NA', quantity: 40 }],
    ])
    const received = [
      { lineId: 'l1', qty: 60 }, { lineId: 'l1', qty: 40 }, { lineId: 'l2', qty: 40 },
    ]
    expect(buildStockIncrements(received, poLines, 'US-BAL')).toEqual([
      { warehouse_code: 'US-BAL', sku: 'EBH9NA', delta: 100 },
      { warehouse_code: 'US-BAL', sku: 'EBH10NA', delta: 40 },
    ])
  })
  it('skips unknown lines and zero qtys', () => {
    const poLines = new Map([['l1', { id: 'l1', sku: 'EBH9NA', quantity: 10 }]])
    expect(buildStockIncrements([{ lineId: 'nope', qty: 5 }], poLines, 'US-BAL')).toEqual([])
  })
})
