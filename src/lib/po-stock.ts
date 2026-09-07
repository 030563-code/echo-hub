// Stock-shortfall flagging for the raise form (slice 5d). NON-BLOCKING — a PO can
// always be raised; this just surfaces lines whose ordered qty exceeds the current
// (dummy until the stocktake/ONIX feed lands) warehouse-on-hand.

export interface Shortfall {
  sku: string
  ordered: number
  available: number
}

/** True if this line's ordered qty exceeds available stock (the shipped per-line check). */
export function isLineShort(
  line: { sku: string; quantity: number },
  stockBySku: Record<string, number>
): boolean {
  return Boolean(line.sku) && line.quantity > (stockBySku[line.sku] ?? 0)
}

/** Lines whose ordered quantity exceeds available stock for that SKU. */
export function stockShortfalls(
  lines: { sku: string; quantity: number }[],
  stockBySku: Record<string, number>
): Shortfall[] {
  return lines
    .filter((l) => isLineShort(l, stockBySku))
    .map((l) => ({ sku: l.sku, ordered: l.quantity, available: stockBySku[l.sku] ?? 0 }))
}
