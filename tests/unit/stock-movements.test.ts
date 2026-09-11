import { describe, it, expect } from 'vitest'
import {
  MOVEMENT_KINDS,
  buildReceiptMovements,
  buildManufacturedMovements,
  buildDispatchMovements,
  ESTIMATED_CONSUMPTION_NOTE,
} from '@/lib/stock/movements'
import type { SuppliedBomRow } from '@/lib/mrp/supplied-materials'

const poLines = new Map([
  ['l1', { id: 'l1', sku: 'EBH9NA', quantity: 100 }],
  ['l2', { id: 'l2', sku: 'EBH10NA', quantity: 40 }],
])

describe('MOVEMENT_KINDS', () => {
  it('names the seven ways a level can change', () => {
    expect([...MOVEMENT_KINDS]).toEqual([
      'receipt', 'count', 'manufactured', 'shipped_out', 'customer_dispatch', 'material_consumed', 'adjustment',
    ])
  })
})

describe('buildReceiptMovements', () => {
  it('makes one movement per receipt row, ref = that row', () => {
    const out = buildReceiptMovements(
      [
        { id: 'r1', po_line_id: 'l1', qty_received: 60 },
        { id: 'r2', po_line_id: 'l1', qty_received: 40 },
        { id: 'r3', po_line_id: 'l2', qty_received: 40 },
      ],
      poLines,
      'US-BAL',
    )
    expect(out).toHaveLength(3)
    expect(out[0]).toEqual({
      item_kind: 'finished', warehouse_code: 'US-BAL', sku: 'EBH9NA', kind: 'receipt',
      quantity: 60, ref_type: 'po_line_receipt', ref_id: 'r1',
    })
    // Two receipts on one line stay two rows: each is its own idempotency key.
    expect(out.map((m) => m.ref_id)).toEqual(['r1', 'r2', 'r3'])
  })

  it('skips unknown lines and non-positive quantities', () => {
    const out = buildReceiptMovements(
      [
        { id: 'r1', po_line_id: 'nope', qty_received: 5 },
        { id: 'r2', po_line_id: 'l1', qty_received: 0 },
        { id: 'r3', po_line_id: 'l1', qty_received: -3 },
      ],
      poLines,
      'US-BAL',
    )
    expect(out).toEqual([])
  })
})

const BOM: SuppliedBomRow[] = [
  { finished_sku: 'EBH9NA', component_code: 'PC350FR-UV21', component_desc: 'PC350 FR UV 2.1 wide', qty_per: 2.85 },
  { finished_sku: 'EBH9NA', component_code: 'ACI-T40', component_desc: 'Senizol T40', qty_per: 8 },
  { finished_sku: 'EBH9NA', component_code: 'GRP-SLTF', component_desc: 'Group slitting fee', qty_per: 1 },
  { finished_sku: 'EBH9NA', component_code: 'PC350FR-TRNS', component_desc: 'Transport', qty_per: 1 },
  { finished_sku: 'EBH8NA', component_code: 'PC350FR-UV21', component_desc: 'PC350 FR UV 2.1 wide', qty_per: 9.3 },
]

describe('buildManufacturedMovements', () => {
  it('adds finished goods at EB-SRO, aggregated by sku, and consumes materials as estimated', () => {
    const out = buildManufacturedMovements(
      'bamida-1',
      [{ sku: 'EBH9NA', quantity: 30 }, { sku: 'EBH9NA', quantity: 20 }],
      BOM,
    )
    const finished = out.filter((m) => m.item_kind === 'finished')
    const materials = out.filter((m) => m.item_kind === 'material')

    expect(finished).toEqual([
      expect.objectContaining({
        warehouse_code: 'EB-SRO', sku: 'EBH9NA', kind: 'manufactured', quantity: 50,
        ref_type: 'po_manufacturing', ref_id: 'bamida-1',
      }),
    ])
    // 50 x 2.85 = 142.5 of fabric, 50 x 8 = 400 of infill, both negative and estimated.
    expect(materials).toEqual([
      expect.objectContaining({ sku: 'PC350FR-UV21', kind: 'material_consumed', quantity: -142.5, estimated: true, note: ESTIMATED_CONSUMPTION_NOTE }),
      expect.objectContaining({ sku: 'ACI-T40', kind: 'material_consumed', quantity: -400, estimated: true }),
    ])
    // Every movement shares the Bamida order as ref, so a retry is one no-op.
    expect(new Set(out.map((m) => m.ref_id))).toEqual(new Set(['bamida-1']))
  })

  it('never consumes a charge line and never touches another sku recipe', () => {
    const out = buildManufacturedMovements('b', [{ sku: 'EBH9NA', quantity: 1 }], BOM)
    const codes = out.filter((m) => m.item_kind === 'material').map((m) => m.sku)
    expect(codes).not.toContain('GRP-SLTF')
    expect(codes).not.toContain('PC350FR-TRNS')
    // EBH8NA's fabric row must not leak into an H9 order.
    expect(out.find((m) => m.sku === 'PC350FR-UV21')?.quantity).toBe(-2.85)
  })

  it('rounds material consumption to three decimals', () => {
    const bom: SuppliedBomRow[] = [{ finished_sku: 'X', component_code: 'C', component_desc: null, qty_per: 0.3333333 }]
    const out = buildManufacturedMovements('b', [{ sku: 'X', quantity: 3 }], bom)
    expect(out.find((m) => m.sku === 'C')?.quantity).toBe(-1)
  })

  it('produces nothing for empty or non-positive lines', () => {
    expect(buildManufacturedMovements('b', [{ sku: null, quantity: 5 }, { sku: 'EBH9NA', quantity: 0 }], BOM)).toEqual([])
  })
})

describe('buildDispatchMovements', () => {
  it('deducts each goods line at its own depot and aggregates by (depot, sku)', () => {
    const out = buildDispatchMovements('inv-1', [
      { sku: 'EBH9NA', quantity: 10, is_shipping: false, ship_from_depot: 'US-SBD' },
      { sku: 'EBH9NA', quantity: 5, is_shipping: false, ship_from_depot: 'US-SBD' },
      // A kit line is always Baltimore regardless of the deal's depot.
      { sku: 'HKNA', quantity: 15, is_shipping: false, ship_from_depot: 'US-BAL' },
      { sku: 'LTLNA', quantity: 1, is_shipping: true, ship_from_depot: 'US-SBD' },
      { sku: null, quantity: 3, is_shipping: false, ship_from_depot: 'US-SBD' },
    ])
    expect(out).toEqual([
      expect.objectContaining({ warehouse_code: 'US-SBD', sku: 'EBH9NA', kind: 'customer_dispatch', quantity: -15, ref_type: 'customer_invoice', ref_id: 'inv-1', estimated: false }),
      expect.objectContaining({ warehouse_code: 'US-BAL', sku: 'HKNA', quantity: -15 }),
    ])
  })

  it('rounds a fractional quantity and says so on the movement', () => {
    const out = buildDispatchMovements('inv-2', [
      { sku: 'EBH9NA', quantity: 2.5, is_shipping: false, ship_from_depot: 'US-BAL' },
    ])
    expect(out[0].quantity).toBe(-3)
    expect(out[0].estimated).toBe(true)
    expect(out[0].note).toContain('2.5')
  })

  it('skips a line that rounds to nothing', () => {
    expect(buildDispatchMovements('inv-3', [
      { sku: 'EBH9NA', quantity: 0.4, is_shipping: false, ship_from_depot: 'US-BAL' },
    ])).toEqual([])
  })
})
