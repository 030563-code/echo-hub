import { describe, it, expect } from 'vitest'
import { countState, deriveFinishedPositions, type PositionInputs } from '@/lib/stock/positions'

const NOW = new Date('2026-09-11T12:00:00Z')

const empty: PositionInputs = {
  levels: [],
  sroCommitted: [],
  inProduction: [],
  depotCommitted: [],
  inbound: [],
  sroWarehouse: 'EB-SRO',
}

describe('countState', () => {
  it('is never for a missing or unparseable date', () => {
    expect(countState(null, NOW)).toBe('never')
    expect(countState('not a date', NOW)).toBe('never')
  })

  it('flips from fresh to stale after the stale window', () => {
    expect(countState('2026-06-14T12:00:00Z', NOW)).toBe('fresh') // 89 days
    expect(countState('2026-06-13T12:00:00Z', NOW)).toBe('fresh') // 90 days, still fresh
    expect(countState('2026-06-12T12:00:00Z', NOW)).toBe('stale') // 91 days
  })
})

describe('deriveFinishedPositions', () => {
  it('reads on hand and count state from the balance rows', () => {
    const rows = deriveFinishedPositions(
      {
        ...empty,
        levels: [
          { warehouse_code: 'US-BAL', sku: 'EBH9NA', product_name: 'H9', quantity_on_hand: 12, last_counted_at: '2026-09-01T00:00:00Z' },
          { warehouse_code: 'EB-SRO', sku: 'EBH9NA', product_name: null, quantity_on_hand: 0, last_counted_at: null },
        ],
      },
      NOW,
    )
    expect(rows.map((r) => [r.warehouse_code, r.on_hand, r.count_state])).toEqual([
      ['EB-SRO', 0, 'never'],
      ['US-BAL', 12, 'fresh'],
    ])
  })

  it('commits SRO lines at the SRO warehouse and lets available go negative', () => {
    const rows = deriveFinishedPositions(
      {
        ...empty,
        levels: [{ warehouse_code: 'EB-SRO', sku: 'EBH9NA', product_name: null, quantity_on_hand: 5, last_counted_at: null }],
        sroCommitted: [{ sku: 'EBH9NA', quantity: 8 }, { sku: 'EBH9NA', quantity: 2 }],
      },
      NOW,
    )
    expect(rows[0]).toMatchObject({ on_hand: 5, committed: 10, available: -5 })
  })

  it('shows in production only at the SRO warehouse', () => {
    const rows = deriveFinishedPositions(
      { ...empty, inProduction: [{ sku: 'EBH9NA', quantity: 500 }] },
      NOW,
    )
    expect(rows).toEqual([
      expect.objectContaining({ warehouse_code: 'EB-SRO', sku: 'EBH9NA', on_hand: 0, in_production: 500, count_state: 'never' }),
    ])
  })

  it('commits depot invoice lines at the ship-from depot, rounded to whole units', () => {
    const rows = deriveFinishedPositions(
      {
        ...empty,
        depotCommitted: [
          { warehouse_code: 'US-SBD', sku: 'EBH9NA', quantity: 2.5 },
          { warehouse_code: 'US-BAL', sku: 'HKNA', quantity: 15 },
        ],
      },
      NOW,
    )
    expect(rows.map((r) => [r.warehouse_code, r.sku, r.committed])).toEqual([
      ['US-BAL', 'HKNA', 15],
      ['US-SBD', 'EBH9NA', 3],
    ])
  })

  it('splits inbound into on order and in transit by the chain SPOT id', () => {
    const rows = deriveFinishedPositions(
      {
        ...empty,
        inbound: [
          { warehouse_code: 'CA-HAM', sku: 'EBH9NA', outstanding: 40, in_transit: false },
          { warehouse_code: 'CA-HAM', sku: 'EBH9NA', outstanding: 60, in_transit: true },
          { warehouse_code: 'CA-HAM', sku: 'EBH10NA', outstanding: 0, in_transit: false },
        ],
      },
      NOW,
    )
    expect(rows).toEqual([
      expect.objectContaining({ warehouse_code: 'CA-HAM', sku: 'EBH9NA', inbound_on_order: 40, inbound_in_transit: 60 }),
    ])
    // A fully received line contributes nothing and makes no row.
    expect(rows.find((r) => r.sku === 'EBH10NA')).toBeUndefined()
  })

  it('orders rows by warehouse then sku', () => {
    const rows = deriveFinishedPositions(
      {
        ...empty,
        levels: [
          { warehouse_code: 'US-SBD', sku: 'EBH9NA', product_name: null, quantity_on_hand: 1, last_counted_at: null },
          { warehouse_code: 'CA-HAM', sku: 'HKNA', product_name: null, quantity_on_hand: 1, last_counted_at: null },
          { warehouse_code: 'CA-HAM', sku: 'BUNNA', product_name: null, quantity_on_hand: 1, last_counted_at: null },
        ],
      },
      NOW,
    )
    expect(rows.map((r) => `${r.warehouse_code}/${r.sku}`)).toEqual(['CA-HAM/BUNNA', 'CA-HAM/HKNA', 'US-SBD/EBH9NA'])
  })
})
