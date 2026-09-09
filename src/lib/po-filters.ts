/**
 * Filtering the purchase order board.
 *
 * Dean, 9 Sep 2026: "The POs that are already approved should really be under
 * an approved section under the kanban table, or there must be some way of
 * filtering similar to the quotes hub. We should also be able to advanced
 * filter through the POs."
 *
 * The real complaint underneath it: approved depot orders pile up in the first
 * column with nothing to do about them until the goods land, so the board fills
 * with rows nobody is acting on. A column for them would be a seventh place to
 * look; a filter lets you decide what you are looking at.
 *
 * CLIENT-SIDE, and that is the opposite of the deals filter next door
 * ([[deal-filters]]), for a reason worth writing down. The deals board pages
 * against HubSpot, so filtering rows already on screen would answer "no such
 * deal" for one that simply sat outside the fetched window, which is a filter
 * that lies. The PO board loads every open order in one query, so the rows on
 * screen ARE the data and narrowing them here is honest.
 *
 * Pure module: no imports from the app, so both the board and its tests can use
 * it, and the filter and the count can never disagree about what is active.
 */

import type { PurchaseOrder } from './erp-types'
import { chainNumber, legLabel } from './po-number'
import { effectiveStage, type LifecycleStage } from './po-lifecycle'

export type PoFilters = {
  /** Free text over the same fields the search box always covered. */
  q: string
  /** `purchase_orders.status`. Empty means every status. */
  statuses: string[]
  /** Board column, derived or persisted. Empty means every column. */
  stages: LifecycleStage[]
  /** Which leg of the chain. Empty means every leg. */
  legs: string[]
  /** Matches an order with this entity on EITHER end. Empty means all. */
  entities: string[]
  /** 'stock' or 'manufacture'. Empty means both, and orders with neither. */
  fulfilment: string[]
  /** Raised on or after, YYYY-MM-DD. Blank means no lower bound. */
  from: string
  /** Raised on or before, YYYY-MM-DD. Blank means no upper bound. */
  to: string
}

export const EMPTY_PO_FILTERS: PoFilters = {
  q: '',
  statuses: [],
  stages: [],
  legs: [],
  entities: [],
  fulfilment: [],
  from: '',
  to: '',
}

/**
 * How many filters are narrowing the board, for the badge on the bar.
 *
 * A date RANGE counts as one thing, not two, because that is how a person
 * thinks about it: they filtered by date, once.
 */
export function activePoFilterCount(f: PoFilters): number {
  let n = 0
  if (f.q.trim()) n++
  if (f.statuses.length) n++
  if (f.stages.length) n++
  if (f.legs.length) n++
  if (f.entities.length) n++
  if (f.fulfilment.length) n++
  if (f.from || f.to) n++
  return n
}

/** The haystack the free-text box searches. Unchanged from the old search. */
function haystack(o: PurchaseOrder): string {
  return [
    o.po_number,
    chainNumber(o),
    o.from_entity,
    o.to_entity,
    o.status,
    o.fulfilment_type,
    o.reference_po_number,
    legLabel(o.leg),
    (o.lines ?? []).map((l) => l.sku).join(' '),
    (o.lines ?? []).map((l) => l.product_name).join(' '),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
}

/**
 * Apply the filters. Every clause is AND, and an EMPTY list means "do not
 * narrow on this", never "match nothing" — a filter that empties the board the
 * moment you open it is a filter nobody uses twice.
 *
 * `today` is threaded into effectiveStage so a stage filter can be tested at a
 * chosen date, the same way deriveStage takes one.
 */
export function applyPoFilters(
  orders: readonly PurchaseOrder[],
  f: PoFilters,
  today?: string,
): PurchaseOrder[] {
  const q = f.q.trim().toLowerCase()
  const statuses = new Set(f.statuses)
  const stages = new Set(f.stages)
  const legs = new Set(f.legs)
  const entities = new Set(f.entities)
  const fulfilment = new Set(f.fulfilment)

  return orders.filter((o) => {
    if (q && !haystack(o).includes(q)) return false
    if (statuses.size && !statuses.has(o.status)) return false
    if (legs.size && !legs.has(o.leg)) return false
    if (fulfilment.size && !fulfilment.has(o.fulfilment_type ?? '')) return false
    if (entities.size) {
      const from = o.from_entity ?? ''
      const to = o.to_entity ?? ''
      if (!entities.has(from) && !entities.has(to)) return false
    }
    if (stages.size && !stages.has(effectiveStage(o, today))) return false
    if (f.from || f.to) {
      // Compared as YYYY-MM-DD strings, which sort correctly and sidestep the
      // timezone question entirely: both sides are the calendar day the row
      // was written, as stored.
      const day = String(o.created_at ?? '').slice(0, 10)
      if (!day) return false
      if (f.from && day < f.from) return false
      if (f.to && day > f.to) return false
    }
    return true
  })
}
