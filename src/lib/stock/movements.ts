/**
 * Stock movements: the ledger rows behind every change to a stock level.
 *
 * Dean, 9 Sep 2026: "this thing must be able to deduct stock accurately and
 * calculate committed stock and stock on hand across the stock board from
 * s.r.o to depots." Before this, warehouse_stock_levels only ever went up (the
 * depot receipt was its sole writer) and nothing recorded why a number changed.
 *
 * This module is the pure half: the builders that turn a business event into
 * signed movement rows. The rows are applied by the hub_apply_stock_movements
 * RPC through @/lib/stock/apply, which is the only file allowed to call it.
 *
 * Idempotency is the partial unique index on (kind, ref_type, ref_id,
 * warehouse_code, sku), so every builder must give a movement a ref that is
 * stable across retries: the receipt row id, the Bamida order id, the invoice
 * id. A retried hook then applies nothing twice.
 */

import { SRO_WAREHOUSE } from '@/lib/stock/warehouses'
import { SUPPLIED_CHARGE_CODES, type SuppliedBomRow } from '@/lib/mrp/supplied-materials'

export const MOVEMENT_KINDS = [
  'receipt',
  'count',
  'manufactured',
  'shipped_out',
  'customer_dispatch',
  'material_consumed',
  'adjustment',
] as const
export type MovementKind = (typeof MOVEMENT_KINDS)[number]

export type ItemKind = 'finished' | 'material'

export interface StockMovementInput {
  item_kind: ItemKind
  warehouse_code: string
  /** Finished goods: the order-line code (EBH9NA). Materials: mrp_bom_map.component_code. */
  sku: string
  kind: MovementKind
  /** Signed delta. Finished goods are whole units; materials may be fractional. */
  quantity: number
  ref_type: string
  ref_id: string
  estimated?: boolean
  note?: string
}

const round3 = (n: number) => Math.round(n * 1000) / 1000

// ---------------------------------------------------------------------------
// (a) Depot receipt: goods landed at the depot that ordered them.
// ---------------------------------------------------------------------------

export interface ReceiptRow {
  id: string
  po_line_id: string
  qty_received: number
}
export interface PoLineLite {
  id: string
  sku: string
  quantity: number
}

/**
 * One movement per receipt row, ref = the receipt row's own id. Per row rather
 * than per batch on purpose: a double-submitted batch still creates new
 * receipt rows (existing behaviour, bounded by the remaining-quantity check),
 * and each one deserves its own ledger line.
 */
export function buildReceiptMovements(
  receipts: readonly ReceiptRow[],
  poLines: ReadonlyMap<string, PoLineLite>,
  depot: string,
): StockMovementInput[] {
  const out: StockMovementInput[] = []
  for (const r of receipts) {
    const line = poLines.get(r.po_line_id)
    const qty = Number(r.qty_received)
    if (!line || !line.sku || !(qty > 0)) continue
    out.push({
      item_kind: 'finished',
      warehouse_code: depot,
      sku: line.sku,
      kind: 'receipt',
      quantity: Math.trunc(qty),
      ref_type: 'po_line_receipt',
      ref_id: r.id,
    })
  }
  return out
}

// ---------------------------------------------------------------------------
// (b) Bamida press Manufacturing finished: the barriers now exist at s.r.o.,
//     and the s.r.o.-owned materials they were built from are gone.
// ---------------------------------------------------------------------------

export interface ManufacturedLine {
  sku: string | null
  quantity: number | null
}

export const ESTIMATED_CONSUMPTION_NOTE =
  'Estimated from the unverified supplied-components bill of materials; the next count resets this.'

/**
 * Finished goods: +quantity per SKU at EB-SRO, aggregated by SKU. Materials:
 * -(qty_per x quantity) per component at EB-SRO, flagged estimated because no
 * row of mrp_bom_map is verified yet (Dean's D2, 9 Sep 2026). Charge lines
 * (slitting fee, transport) are not stock and are skipped. Both halves share
 * the Bamida order id as ref, so the index makes a retry a no-op for all of
 * them at once.
 */
export function buildManufacturedMovements(
  bamidaPoId: string,
  lines: readonly ManufacturedLine[],
  bom: readonly SuppliedBomRow[],
): StockMovementInput[] {
  const bySku = new Map<string, number>()
  for (const l of lines) {
    const sku = String(l.sku ?? '').trim()
    const qty = Math.trunc(Number(l.quantity ?? 0))
    if (sku === '' || !(qty > 0)) continue
    bySku.set(sku, (bySku.get(sku) ?? 0) + qty)
  }

  const out: StockMovementInput[] = []
  for (const [sku, qty] of bySku) {
    out.push({
      item_kind: 'finished',
      warehouse_code: SRO_WAREHOUSE,
      sku,
      kind: 'manufactured',
      quantity: qty,
      ref_type: 'po_manufacturing',
      ref_id: bamidaPoId,
      note: 'Bamida reported this order finished',
    })
  }

  const consumed = new Map<string, number>()
  for (const [sku, qty] of bySku) {
    for (const row of bom) {
      if (row.finished_sku !== sku) continue
      if (SUPPLIED_CHARGE_CODES.has(row.component_code)) continue
      const per = Number(row.qty_per)
      if (!(per > 0)) continue
      consumed.set(row.component_code, round3((consumed.get(row.component_code) ?? 0) + per * qty))
    }
  }
  for (const [code, used] of consumed) {
    if (!(used > 0)) continue
    out.push({
      item_kind: 'material',
      warehouse_code: SRO_WAREHOUSE,
      sku: code,
      kind: 'material_consumed',
      quantity: -used,
      ref_type: 'po_manufacturing',
      ref_id: bamidaPoId,
      estimated: true,
      note: ESTIMATED_CONSUMPTION_NOTE,
    })
  }
  return out
}

// ---------------------------------------------------------------------------
// (d) A US customer invoice reaches `sent`: the goods left the depot.
// ---------------------------------------------------------------------------

export interface DispatchLine {
  sku: string | null
  quantity: number | null
  is_shipping: boolean | null
  ship_from_depot: string | null
}

/**
 * -quantity per (depot, SKU) for every goods line on the invoice. Freight
 * lines are charges, not barriers, and are skipped; so is a line with no SKU
 * or no depot. Invoice quantities are numeric(12,2); a fractional one is
 * rounded and the movement says so, because barriers do not ship by the half.
 */
export function buildDispatchMovements(
  invoiceId: string,
  lines: readonly DispatchLine[],
): StockMovementInput[] {
  const byKey = new Map<string, { depot: string; sku: string; qty: number; rounded: string[] }>()
  for (const l of lines) {
    if (l.is_shipping) continue
    const sku = String(l.sku ?? '').trim()
    const depot = String(l.ship_from_depot ?? '').trim()
    if (sku === '' || depot === '') continue
    const raw = Number(l.quantity ?? 0)
    const qty = Math.round(raw)
    if (!(qty > 0)) continue
    const key = `${depot}|${sku}`
    const entry = byKey.get(key) ?? { depot, sku, qty: 0, rounded: [] }
    entry.qty += qty
    if (qty !== raw) entry.rounded.push(String(raw))
    byKey.set(key, entry)
  }

  const out: StockMovementInput[] = []
  for (const { depot, sku, qty, rounded } of byKey.values()) {
    out.push({
      item_kind: 'finished',
      warehouse_code: depot,
      sku,
      kind: 'customer_dispatch',
      quantity: -qty,
      ref_type: 'customer_invoice',
      ref_id: invoiceId,
      estimated: rounded.length > 0,
      note:
        rounded.length > 0
          ? `Rounded from ${rounded.join(', ')}; the invoice carried a fractional quantity`
          : 'Customer invoice sent',
    })
  }
  return out
}
