export interface ReceiptLine { lineId: string; qty: number }
export interface POLineLite { id: string; sku: string; quantity: number }
export interface StockIncrement { warehouse_code: string; sku: string; delta: number }

/** Pure: received batch → per-sku stock deltas for the receiving depot. */
export function buildStockIncrements(
  received: ReceiptLine[], poLines: Map<string, POLineLite>, depot: string,
): StockIncrement[] {
  const bySku = new Map<string, number>()
  for (const r of received) {
    const line = poLines.get(r.lineId)
    if (!line || r.qty <= 0) continue
    bySku.set(line.sku, (bySku.get(line.sku) ?? 0) + r.qty)
  }
  return [...bySku.entries()].map(([sku, delta]) => ({ warehouse_code: depot, sku, delta }))
}

const MS_PER_DAY = 86_400_000

/**
 * Pure: shipped→delivered span in fractional days, for lead-time actuals.
 * Null when shippedAt is missing/unparseable, or the span is implausible
 * (<= 0, or >= 365 days — matches the mrp_lead_time_actuals days check).
 */
export function transitDays(shippedAt: string | null, deliveredAt: string): number | null {
  if (!shippedAt) return null
  const shipped = Date.parse(shippedAt)
  const delivered = Date.parse(deliveredAt)
  if (Number.isNaN(shipped) || Number.isNaN(delivered)) return null
  const days = (delivered - shipped) / MS_PER_DAY
  if (days <= 0 || days >= 365) return null
  return days
}
