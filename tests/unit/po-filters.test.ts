import { describe, it, expect } from 'vitest'
import { applyPoFilters, activePoFilterCount, EMPTY_PO_FILTERS, type PoFilters } from '@/lib/po-filters'
import type { PurchaseOrder } from '@/lib/erp-types'

/**
 * Dean, 9 Sep: approved orders pile up with nothing to do about them, so the
 * board needs filtering rather than a seventh column for them to pile up in.
 *
 * The rule that matters most here: an EMPTY list means "do not narrow on this",
 * never "match nothing". A filter that empties the board the moment it is
 * opened is a filter nobody uses twice.
 */

const order = (over: Partial<PurchaseOrder> = {}): PurchaseOrder =>
  ({
    id: over.id ?? 'id-1',
    po_number: 'PO-01174',
    master_ref: null,
    reference_po_number: null,
    parent_po_id: null,
    leg: 'DEPOT_TO_EB_GROUP',
    status: 'approved',
    from_entity: 'US-BAL',
    to_entity: 'EB-GROUP',
    fulfilment_type: null,
    lifecycle_stage: null,
    created_at: '2026-09-04T10:00:00Z',
    lines: [{ sku: 'EBH9NA', product_name: 'Echo Barrier H9', quantity: 10 }],
    ...over,
  }) as unknown as PurchaseOrder

const f = (over: Partial<PoFilters> = {}): PoFilters => ({ ...EMPTY_PO_FILTERS, ...over })

describe('applyPoFilters', () => {
  const depot = order({ id: 'a', po_number: 'PO-01174' })
  const sroStock = order({
    id: 'b',
    po_number: 'PO-01176',
    leg: 'EB_GROUP_TO_SRO',
    status: 'ready_for_shipment',
    fulfilment_type: 'stock',
    from_entity: 'EB-GROUP',
    to_entity: 'EB-SRO',
    created_at: '2026-09-09T10:00:00Z',
  })
  const bamida = order({
    id: 'c',
    po_number: 'PO-01178',
    leg: 'SRO_TO_SUPPLIER',
    status: 'approved',
    from_entity: 'EB-SRO',
    to_entity: 'SUPPLIER',
    created_at: '2026-09-09T11:00:00Z',
  })
  const all = [depot, sroStock, bamida]

  it('returns everything when nothing is set', () => {
    expect(applyPoFilters(all, EMPTY_PO_FILTERS)).toHaveLength(3)
  })

  it('narrows on status, which is the Approved question Dean asked', () => {
    expect(applyPoFilters(all, f({ statuses: ['approved'] })).map((o) => o.id)).toEqual(['a', 'c'])
    expect(applyPoFilters(all, f({ statuses: ['ready_for_shipment'] })).map((o) => o.id)).toEqual(['b'])
  })

  it('ORs within a list and ANDs between them', () => {
    expect(applyPoFilters(all, f({ statuses: ['approved', 'ready_for_shipment'] }))).toHaveLength(3)
    // status AND leg: only the Bamida order is both.
    expect(
      applyPoFilters(all, f({ statuses: ['approved'], legs: ['SRO_TO_SUPPLIER'] })).map((o) => o.id),
    ).toEqual(['c'])
  })

  it('matches an entity on EITHER end, because a leg has two', () => {
    expect(applyPoFilters(all, f({ entities: ['EB-SRO'] })).map((o) => o.id)).toEqual(['b', 'c'])
    expect(applyPoFilters(all, f({ entities: ['US-BAL'] })).map((o) => o.id)).toEqual(['a'])
  })

  it('narrows on the BOARD COLUMN, derived the same way the board derives it', () => {
    // The stock order derives to Ready for shipment; the depot order does not.
    expect(applyPoFilters(all, f({ stages: ['ready_for_shipment'] })).map((o) => o.id)).toEqual(['b'])
    expect(applyPoFilters(all, f({ stages: ['depot_group'] })).map((o) => o.id)).toEqual(['a'])
  })

  it('honours a persisted stage over the derived one, like the board does', () => {
    const dragged = order({ id: 'd', lifecycle_stage: 'shipping' })
    expect(applyPoFilters([dragged], f({ stages: ['shipping'] }))).toHaveLength(1)
    expect(applyPoFilters([dragged], f({ stages: ['depot_group'] }))).toHaveLength(0)
  })

  it('filters by fulfilment type, and an order with none is excluded when one is asked for', () => {
    expect(applyPoFilters(all, f({ fulfilment: ['stock'] })).map((o) => o.id)).toEqual(['b'])
    expect(applyPoFilters(all, f({ fulfilment: ['manufacture'] }))).toHaveLength(0)
  })

  it('treats the date range as inclusive calendar days on both ends', () => {
    expect(applyPoFilters(all, f({ from: '2026-09-09' })).map((o) => o.id)).toEqual(['b', 'c'])
    expect(applyPoFilters(all, f({ to: '2026-09-04' })).map((o) => o.id)).toEqual(['a'])
    expect(applyPoFilters(all, f({ from: '2026-09-04', to: '2026-09-04' })).map((o) => o.id)).toEqual(['a'])
  })

  it('searches the number, the entities, the status and the lines', () => {
    expect(applyPoFilters(all, f({ q: '01178' })).map((o) => o.id)).toEqual(['c'])
    expect(applyPoFilters(all, f({ q: 'EBH9NA' }))).toHaveLength(3)
    expect(applyPoFilters(all, f({ q: 'echo barrier h9' }))).toHaveLength(3)
    // Case and surrounding whitespace do not matter.
    expect(applyPoFilters(all, f({ q: '  Ready_For_Shipment ' })).map((o) => o.id)).toEqual(['b'])
  })

  it('never invents a match: an unknown value narrows to nothing rather than to everything', () => {
    expect(applyPoFilters(all, f({ statuses: ['not_a_status'] }))).toHaveLength(0)
  })
})

describe('activePoFilterCount', () => {
  it('counts nothing when nothing is set', () => {
    expect(activePoFilterCount(EMPTY_PO_FILTERS)).toBe(0)
  })

  it('counts a date RANGE once, because a person filtered by date once', () => {
    expect(activePoFilterCount(f({ from: '2026-09-01' }))).toBe(1)
    expect(activePoFilterCount(f({ from: '2026-09-01', to: '2026-09-30' }))).toBe(1)
  })

  it('ignores a search box holding only whitespace', () => {
    expect(activePoFilterCount(f({ q: '   ' }))).toBe(0)
    expect(activePoFilterCount(f({ q: 'PO-1' }))).toBe(1)
  })

  it('adds up across kinds', () => {
    expect(activePoFilterCount(f({ q: 'x', statuses: ['approved'], legs: ['SRO_TO_CARGO'], to: '2026-09-30' }))).toBe(4)
  })
})

describe('the remembered board view keeps working for somebody who had one before', () => {
  it('parses a stored row written before filters existed', async () => {
    const { parsePoBoardView } = await import('@/lib/page-drafts')
    // Exactly what user_page_state held yesterday. Bumping the version would
    // have thrown this away and lost everyone their view and their search.
    const old = parsePoBoardView({ v: 1, view: 'table', q: 'PO-011' })
    expect(old).not.toBeNull()
    expect(old!.view).toBe('table')
    expect(old!.q).toBe('PO-011')
    expect(old!.statuses).toEqual([])
    expect(old!.from).toBe('')
  })
})
