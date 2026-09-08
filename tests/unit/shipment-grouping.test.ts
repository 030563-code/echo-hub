import { describe, it, expect } from 'vitest'
import { groupBySpotId } from '@/lib/shipment-grouping'
import type { ShipmentContent } from '@/lib/erp-types'

const line = (over: Partial<ShipmentContent>): ShipmentContent =>
  ({
    id: Math.random().toString(36).slice(2),
    spot_id: 'SPOT1',
    container_ref: 'MSCU1234567',
    sku: 'EBH9NA',
    product_name: 'Echo Barrier H9',
    qty: 10,
    depot_destination: 'US-BAL',
    status: 'on_water',
    shipped_at: '2026-09-01',
    eta: '2026-10-01',
    po_reference: 'PO-00001276',
    po_id: null,
    created_at: '2026-09-01T00:00:00Z',
    updated_at: '2026-09-01T00:00:00Z',
    ...over,
  }) as ShipmentContent

describe('one row per shipment, not one per SKU', () => {
  it('folds four lines of one container into a single row', () => {
    const grouped = groupBySpotId([
      line({ sku: 'EBH9NA', qty: 10 }),
      line({ sku: 'EBH10NA', qty: 20 }),
      line({ sku: 'EBH8NA', qty: 5 }),
      line({ sku: 'BUNNA', qty: 100 }),
    ])
    expect(grouped).toHaveLength(1)
    expect(grouped[0].spotId).toBe('SPOT1')
    expect(grouped[0].totalQty).toBe(135)
    expect(grouped[0].lines).toHaveLength(4)
  })

  it('keeps separate shipments separate', () => {
    const grouped = groupBySpotId([line({ spot_id: 'SPOT1' }), line({ spot_id: 'SPOT2' })])
    expect(grouped.map((g) => g.spotId).sort()).toEqual(['SPOT1', 'SPOT2'])
  })

  it('gives a line with no SPOT ID somewhere honest to sit', () => {
    const grouped = groupBySpotId([line({ spot_id: '' })])
    expect(grouped[0].spotId).toBe('(no SPOT ID)')
  })
})

describe('a container is only as far along as its slowest line', () => {
  it('takes the least advanced status', () => {
    expect(
      groupBySpotId([line({ status: 'delivered' }), line({ status: 'on_water' })])[0].status,
    ).toBe('on_water')
    expect(
      groupBySpotId([line({ status: 'delivered' }), line({ status: 'customs' })])[0].status,
    ).toBe('customs')
  })

  it('takes the earliest ETA, so nothing is reported as later than it is', () => {
    expect(
      groupBySpotId([line({ eta: '2026-11-01' }), line({ eta: '2026-10-15' })])[0].eta,
    ).toBe('2026-10-15')
  })

  it('ignores a missing date rather than treating it as the earliest', () => {
    expect(groupBySpotId([line({ eta: null }), line({ eta: '2026-10-15' })])[0].eta).toBe('2026-10-15')
    expect(groupBySpotId([line({ eta: null })])[0].eta).toBeNull()
  })
})

describe('every PO on a container is visible', () => {
  it('keeps both when two lines carry different POs', () => {
    const grouped = groupBySpotId([
      line({ po_reference: 'PO-00001276' }),
      line({ po_reference: 'PO-00001277' }),
    ])
    expect(grouped[0].poReferences).toEqual(['PO-00001276', 'PO-00001277'])
  })

  it('splits the comma-joined form the old data used', () => {
    // shipment_contents.po_reference holds "PO-00001276, PO-00001277" on live
    // rows, and matching on it dropped all but the first.
    const grouped = groupBySpotId([line({ po_reference: 'PO-00001276, PO-00001277' })])
    expect(grouped[0].poReferences).toEqual(['PO-00001276', 'PO-00001277'])
  })

  it('does not list the same PO twice', () => {
    const grouped = groupBySpotId([
      line({ po_reference: 'PO-00001276' }),
      line({ po_reference: 'PO-00001276' }),
    ])
    expect(grouped[0].poReferences).toEqual(['PO-00001276'])
  })
})

describe('a split container says so instead of picking a winner', () => {
  it('reports no single depot when the lines disagree', () => {
    expect(groupBySpotId([line({ depot_destination: 'US-BAL' })])[0].depot).toBe('US-BAL')
    expect(
      groupBySpotId([line({ depot_destination: 'US-BAL' }), line({ depot_destination: 'CA-HAM' })])[0]
        .depot,
    ).toBeNull()
  })

  it('reports no single container when the lines disagree', () => {
    expect(
      groupBySpotId([line({ container_ref: 'A' }), line({ container_ref: 'B' })])[0].containerRef,
    ).toBeNull()
  })
})

describe('the order never wobbles', () => {
  it('sorts by soonest arrival, with no-ETA shipments last', () => {
    const grouped = groupBySpotId([
      line({ spot_id: 'C', eta: null }),
      line({ spot_id: 'A', eta: '2026-12-01' }),
      line({ spot_id: 'B', eta: '2026-10-01' }),
    ])
    expect(grouped.map((g) => g.spotId)).toEqual(['B', 'A', 'C'])
  })

  it('falls back to the SPOT ID so equal dates cannot swap between refreshes', () => {
    const grouped = groupBySpotId([
      line({ spot_id: 'SPOT20', eta: '2026-10-01' }),
      line({ spot_id: 'SPOT3', eta: '2026-10-01' }),
    ])
    expect(grouped.map((g) => g.spotId)).toEqual(['SPOT3', 'SPOT20'])
  })
})
