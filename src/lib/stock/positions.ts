/**
 * The stock position of every (warehouse, SKU): on hand, committed, available,
 * inbound, in production, and how fresh the last count is.
 *
 * Nothing here is stored. On hand is the balance table; everything else is
 * derived from orders and invoices at read time, so there is no second source
 * of truth to drift. The loader in board-data.ts does the reads and hands the
 * flat lists in; this module only aggregates.
 *
 * Definitions (Dean, 9 Sep 2026):
 * - Committed at EB-SRO: lines of SRO-leg orders that are ready for shipment
 *   and not yet booked with Cargo Partner. Both branches: fulfil-from-stock
 *   reaches that status directly, manufacture reaches it when Bamida press
 *   finished, which is also when the units are added to on hand.
 * - In production at EB-SRO: lines of Bamida orders not yet finished.
 * - Committed at a depot: goods lines of customer invoices that carry a number
 *   but have not gone out (tax_calculated, filed, documented).
 * - Inbound to a depot: outstanding lines of approved depot orders, split into
 *   in transit (the chain has a Cargo Partner SPOT id) and on order.
 * - Available = on hand minus committed. It may go negative, and the board
 *   shows that in red rather than clamping it away.
 *
 * Pure. Imports only constants.
 */

import { STALE_COUNT_DAYS } from '@/lib/stock/warehouses'

export type CountState = 'never' | 'stale' | 'fresh'

export interface LevelRow {
  warehouse_code: string
  sku: string
  product_name: string | null
  quantity_on_hand: number
  last_counted_at: string | null
}

export interface SkuQty {
  sku: string
  quantity: number
}

export interface DepotSkuQty extends SkuQty {
  warehouse_code: string
}

export interface InboundRow {
  warehouse_code: string
  sku: string
  outstanding: number
  in_transit: boolean
}

export interface PositionInputs {
  levels: readonly LevelRow[]
  /** EB-SRO order lines ready for shipment with no chain SPOT id. */
  sroCommitted: readonly SkuQty[]
  /** Bamida order lines not yet finished. */
  inProduction: readonly SkuQty[]
  /** Numbered-but-unsent customer invoice goods lines, per ship-from depot. */
  depotCommitted: readonly DepotSkuQty[]
  /** Approved depot order lines, quantity net of receipts. */
  inbound: readonly InboundRow[]
  sroWarehouse: string
}

export interface FinishedPosition {
  warehouse_code: string
  sku: string
  product_name: string | null
  on_hand: number
  committed: number
  available: number
  inbound_on_order: number
  inbound_in_transit: number
  in_production: number
  last_counted_at: string | null
  count_state: CountState
}

const MS_PER_DAY = 86_400_000

export function countState(
  lastCountedAt: string | null,
  now: Date,
  staleDays: number = STALE_COUNT_DAYS,
): CountState {
  if (!lastCountedAt) return 'never'
  const at = Date.parse(lastCountedAt)
  if (Number.isNaN(at)) return 'never'
  const ageDays = (now.getTime() - at) / MS_PER_DAY
  return ageDays > staleDays ? 'stale' : 'fresh'
}

/** Whole units. Invoice lines are numeric(12,2); a half barrier does not exist. */
const whole = (n: number) => Math.max(0, Math.round(Number(n) || 0))

export function deriveFinishedPositions(input: PositionInputs, now: Date): FinishedPosition[] {
  const byKey = new Map<string, FinishedPosition>()
  const key = (w: string, s: string) => `${w}|${s}`
  const get = (warehouse: string, sku: string): FinishedPosition => {
    const k = key(warehouse, sku)
    let row = byKey.get(k)
    if (!row) {
      row = {
        warehouse_code: warehouse,
        sku,
        product_name: null,
        on_hand: 0,
        committed: 0,
        available: 0,
        inbound_on_order: 0,
        inbound_in_transit: 0,
        in_production: 0,
        last_counted_at: null,
        count_state: 'never',
      }
      byKey.set(k, row)
    }
    return row
  }

  for (const l of input.levels) {
    const row = get(l.warehouse_code, l.sku)
    row.product_name = l.product_name ?? row.product_name
    row.on_hand = Math.trunc(Number(l.quantity_on_hand) || 0)
    row.last_counted_at = l.last_counted_at
    row.count_state = countState(l.last_counted_at, now)
  }
  for (const c of input.sroCommitted) {
    if (!c.sku) continue
    get(input.sroWarehouse, c.sku).committed += whole(c.quantity)
  }
  for (const p of input.inProduction) {
    if (!p.sku) continue
    get(input.sroWarehouse, p.sku).in_production += whole(p.quantity)
  }
  for (const c of input.depotCommitted) {
    if (!c.sku || !c.warehouse_code) continue
    get(c.warehouse_code, c.sku).committed += whole(c.quantity)
  }
  for (const i of input.inbound) {
    if (!i.sku || !i.warehouse_code) continue
    const qty = whole(i.outstanding)
    if (qty === 0) continue
    const row = get(i.warehouse_code, i.sku)
    if (i.in_transit) row.inbound_in_transit += qty
    else row.inbound_on_order += qty
  }

  const rows = [...byKey.values()]
  for (const row of rows) row.available = row.on_hand - row.committed
  rows.sort(
    (a, b) => a.warehouse_code.localeCompare(b.warehouse_code) || a.sku.localeCompare(b.sku),
  )
  return rows
}
