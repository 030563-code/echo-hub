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
