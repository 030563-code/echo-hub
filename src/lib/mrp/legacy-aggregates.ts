/**
 * Pure aggregation helpers for the LEGACY /mrp board (calculateMRP in
 * src/app/(dashboard)/mrp/actions.ts), extracted so vitest can pin them
 * without a live Supabase — same pattern as board-format.ts / receipts.ts.
 *
 * The legacy board still owns operational decisions (the v2 engine is in
 * shadow), so both helpers exist to stop it reading OPTIMISTIC — i.e.
 * overstating coverage and suppressing reds.
 */

export interface StockRow {
  sku: string;
  product_name: string | null;
  quantity_on_hand: number;
}

export interface POLineRow {
  id: string;
  sku: string;
  quantity: number;
}

export interface PORow {
  lines: POLineRow[] | null;
}

/**
 * In Stock, summed across depots.
 *
 * warehouse_stock_levels holds ONE ROW PER (warehouse, sku) — EBH9NA and
 * EBH10NA each exist in three warehouses. The previous `.set()` over an
 * unordered select kept whichever row PostgREST returned last, so "In Stock"
 * would show a single arbitrary depot's holding rather than the total. Every
 * depot reads 0 today, which masked it; the first real receipt would not.
 *
 * product_name: first non-null wins (the per-depot rows describe the same
 * product; this just makes the pick deterministic instead of order-dependent).
 */
export function sumStockBySku(
  rows: StockRow[]
): Map<string, { product_name: string | null; in_stock: number }> {
  const out = new Map<string, { product_name: string | null; in_stock: number }>();
  for (const row of rows) {
    const prev = out.get(row.sku);
    if (prev) {
      prev.in_stock += row.quantity_on_hand ?? 0;
      if (prev.product_name === null) prev.product_name = row.product_name;
    } else {
      out.set(row.sku, {
        product_name: row.product_name,
        in_stock: row.quantity_on_hand ?? 0,
      });
    }
  }
  return out;
}

/**
 * On Order, NET of what has already physically landed.
 *
 * recordReceipt increments warehouse stock the moment a batch is logged, but
 * the PO keeps its full ordered quantity until it is closed out. Counting the
 * gross ordered qty therefore double-counts every received-but-not-yet-closed
 * unit in cip = in_stock + transit + ordered, inflating coverage and
 * suppressing reds for the whole partial-delivery window.
 *
 * Netting is per LINE and floored at 0, so an over-receipt on one line (the
 * po_line_receipt_guard trigger rejects these, but belt-and-braces) can never
 * borrow against another line's outstanding quantity.
 */
export function netOnOrderBySku(
  pos: PORow[],
  receivedByLine: Map<string, number>
): Map<string, number> {
  const out = new Map<string, number>();
  for (const po of pos) {
    for (const line of po.lines ?? []) {
      const outstanding = Math.max(0, line.quantity - (receivedByLine.get(line.id) ?? 0));
      if (outstanding === 0) continue;
      out.set(line.sku, (out.get(line.sku) ?? 0) + outstanding);
    }
  }
  return out;
}

/** Pure: receipt rows → summed qty_received per po_line_id. */
export function sumReceiptsByLine(
  rows: { po_line_id: string; qty_received: number }[]
): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of rows) {
    out.set(r.po_line_id, (out.get(r.po_line_id) ?? 0) + r.qty_received);
  }
  return out;
}
