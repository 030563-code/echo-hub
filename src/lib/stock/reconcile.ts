/**
 * Ledger gaps: events that should have moved stock and did not.
 *
 * Every hook that writes a movement logs and never throws, by design (a
 * receipt must not fail because the ledger hiccuped). The cost of that choice
 * is that a failed hook leaves no trace except the missing movement. This
 * module finds those: an invoice that reached sent with no customer_dispatch
 * row, a booked chain with no shipped_out row, a finished Bamida order with no
 * manufactured row, a receipt with no receipt row. The board renders the list;
 * a person decides whether to record an adjustment.
 *
 * Pure. The loader in board-data.ts does the reads.
 */

export type GapKind = 'customer_dispatch' | 'shipped_out' | 'manufactured' | 'receipt'

export interface MovementRef {
  kind: string
  ref_type: string
  ref_id: string
}

export interface SentInvoice {
  id: string
  invoice_number: string | null
  status: string
  /** At least one non-shipping line with a SKU. An invoice of freight only moves nothing. */
  has_goods_lines: boolean
  since: string | null
}

export interface BookedSroOrder {
  id: string
  po_number: string | null
  spot_id: string
  since: string | null
}

export interface FinishedBamidaOrder {
  id: string
  po_number: string | null
  finished_at: string
}

export interface ReceiptRow {
  id: string
  po_number: string | null
  sku: string | null
  qty_received: number
  received_at: string | null
}

export interface ReconcileInputs {
  invoices: readonly SentInvoice[]
  bookedSroOrders: readonly BookedSroOrder[]
  finishedBamidaOrders: readonly FinishedBamidaOrder[]
  receipts: readonly ReceiptRow[]
  movements: readonly MovementRef[]
}

export interface LedgerGap {
  kind: GapKind
  ref_type: string
  ref_id: string
  label: string
  href: string | null
  since: string | null
}

const key = (kind: string, refType: string, refId: string) => `${kind}|${refType}|${refId}`

export function findLedgerGaps(input: ReconcileInputs): LedgerGap[] {
  const seen = new Set(input.movements.map((m) => key(m.kind, m.ref_type, m.ref_id)))
  const gaps: LedgerGap[] = []

  for (const inv of input.invoices) {
    if (!inv.has_goods_lines) continue
    if (seen.has(key('customer_dispatch', 'customer_invoice', inv.id))) continue
    gaps.push({
      kind: 'customer_dispatch',
      ref_type: 'customer_invoice',
      ref_id: inv.id,
      label: `Invoice ${inv.invoice_number ?? inv.id} is ${inv.status} with no dispatch recorded`,
      href: null,
      since: inv.since,
    })
  }

  for (const o of input.bookedSroOrders) {
    if (seen.has(key('shipped_out', 'po_shipment', o.id))) continue
    gaps.push({
      kind: 'shipped_out',
      ref_type: 'po_shipment',
      ref_id: o.id,
      label: `${o.po_number ?? o.id} booked (SPOT ${o.spot_id}) with nothing deducted at s.r.o.`,
      href: `/purchase-orders/${o.id}`,
      since: o.since,
    })
  }

  for (const b of input.finishedBamidaOrders) {
    if (seen.has(key('manufactured', 'po_manufacturing', b.id))) continue
    gaps.push({
      kind: 'manufactured',
      ref_type: 'po_manufacturing',
      ref_id: b.id,
      label: `${b.po_number ?? b.id} finished with nothing added at s.r.o.`,
      href: `/purchase-orders/${b.id}`,
      since: b.finished_at,
    })
  }

  for (const r of input.receipts) {
    if (seen.has(key('receipt', 'po_line_receipt', r.id))) continue
    gaps.push({
      kind: 'receipt',
      ref_type: 'po_line_receipt',
      ref_id: r.id,
      label: `Receipt of ${r.qty_received} ${r.sku ?? ''} on ${r.po_number ?? 'a depot order'} not on the ledger`.replace(/\s+/g, ' '),
      href: null,
      since: r.received_at,
    })
  }

  // Oldest first: the longest-standing gap is the one most likely to have
  // already skewed a count.
  gaps.sort((a, b) => (a.since ?? '').localeCompare(b.since ?? '') || a.label.localeCompare(b.label))
  return gaps
}
