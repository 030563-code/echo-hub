import type { PurchaseOrder } from './erp-types'

// Rooted at the SRO order (Juraj/Dean's model): the intercompany order flowing
// depot → group → SRO is ONE order and shares the base number (PO-001); the SRO's
// two fulfilment children are its suffixes — Bamida manufacturing = base-1, Cargo
// transport = base-2. So: PO-001 (the order) / PO-001-1 (Bamida) / PO-001-2 (Cargo).
const LEG_INDEX: Record<PurchaseOrder['leg'], number> = {
  DEPOT_TO_EB_GROUP: 0,
  EB_GROUP_TO_SRO: 0,
  SRO_TO_SUPPLIER: 1,
  SRO_TO_CARGO: 2,
}

/**
 * The "PO-001 / PO-001-1 / PO-001-2" unified chain label (meeting requirement).
 * Derived from the shared `master_ref` + the leg's role: the SRO order reads as
 * the base, its Bamida manufacturing child as base-1, its Cargo transport child
 * as base-2 — trackable end-to-end.
 *
 * DISPLAY-ONLY — the canonical number stays `po_number` (n8n + Cargo Partner look
 * up by that). The trigger's "MR-" master_ref prefix is stripped.
 */
export function chainNumber(po: Pick<PurchaseOrder, 'po_number' | 'master_ref' | 'leg'>): string {
  // No master_ref = no real chain to express → show the canonical number as-is.
  if (!po.master_ref) return po.po_number
  const base = po.master_ref.replace(/^MR-/, '')
  const idx = LEG_INDEX[po.leg] ?? 0
  return idx === 0 ? base : `${base}-${idx}`
}

/**
 * A Hub-minted placeholder number (`PO-01105`) vs a real Xero number written back
 * by n8n (`EBG26086`, `EBUSA26013`, `EBSRO…`). We keep the placeholder internally
 * (it chains master_ref + reference), but never surface it: the real PO number is
 * the Xero one, and until n8n writes it back we show "Awaiting Xero PO number".
 */
export function isPlaceholderPoNumber(poNumber: string | null | undefined): boolean {
  return !poNumber || /^PO-\d+$/i.test(poNumber.trim())
}

export const AWAITING_XERO_PO = 'Awaiting Xero PO number'

/** What to SHOW for a PO number: the real Xero number, else the awaiting label. */
export function displayPoNumber(poNumber: string | null | undefined): string {
  return isPlaceholderPoNumber(poNumber) ? AWAITING_XERO_PO : (poNumber as string)
}

/** Human label for a leg — shared so the board, table and kanban never disagree. */
export function legLabel(leg: string): string {
  if (leg === 'DEPOT_TO_EB_GROUP') return 'Depot → Group'
  if (leg === 'EB_GROUP_TO_SRO') return 'Group → SRO'
  if (leg === 'SRO_TO_SUPPLIER') return 'SRO → Bamida'
  if (leg === 'SRO_TO_CARGO') return 'SRO → Cargo'
  return leg
}

/** True if every line of a PO has been fully received (Σ receipts ≥ ordered qty). */
export function isFullyReceived(lines: { quantity: number; qty_received?: number }[]): boolean {
  if (!lines.length) return false
  return lines.every((l) => (l.qty_received ?? 0) >= l.quantity)
}
