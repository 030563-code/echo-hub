/**
 * Pure money/quote math helpers. No 'server-only' guard — safe to use on either
 * side and easy to unit test. Used by createQuote() to recompute totals
 * server-side rather than trusting the client (audit finding #10).
 */

export interface QuoteLineItemLike {
  total?: number | string | null
  quantity?: number | string | null
  unitPrice?: number | string | null
}

/** Coerce an unknown numeric-ish value to a finite number, defaulting to 0. */
export function toMoney(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : 0
}

/** Round to 2 decimal places (cents), avoiding binary-float drift. */
export function roundCents(value: number): number {
  return Math.round((toMoney(value) + Number.EPSILON) * 100) / 100
}

/**
 * Sum a list of line items to a cents-rounded grand total. Prefers each item's
 * explicit `total`; falls back to quantity × unitPrice. Never returns NaN.
 */
export function computeLineItemsTotal(lineItems: readonly QuoteLineItemLike[] | null | undefined): number {
  if (!Array.isArray(lineItems)) return 0
  const sum = lineItems.reduce((acc, item) => {
    const explicit = item?.total
    const lineTotal =
      explicit !== undefined && explicit !== null && Number.isFinite(Number(explicit))
        ? toMoney(explicit)
        : toMoney(item?.quantity) * toMoney(item?.unitPrice)
    return acc + lineTotal
  }, 0)
  return roundCents(sum)
}

/**
 * Server-side line-item validation, run BEFORE any HubSpot write in createQuote.
 * Rejects unless every item has a finite integer quantity >= 1 and a finite
 * unitPrice >= 0. Returns a human-readable error naming the first offending
 * item, or null when every item is valid. An empty array is valid — the
 * length > 0 gate that decides whether an empty cart is itself an error lives
 * elsewhere (createQuote), not here.
 */
export function validateLineItems(items: { quantity: number; unitPrice: number }[]): string | null {
  for (let i = 0; i < items.length; i++) {
    const { quantity, unitPrice } = items[i]
    if (!Number.isFinite(quantity) || !Number.isInteger(quantity) || quantity < 1) {
      return `Line item ${i + 1} has an invalid quantity — it must be a whole number of at least 1`
    }
    if (!Number.isFinite(unitPrice) || unitPrice < 0) {
      return `Line item ${i + 1} has an invalid unit price — it must be zero or greater`
    }
  }
  return null
}


export interface SkuPriceStatLike {
  medianPrice: number
}

/**
 * A unit price is "suspiciously low" when it's under 20% of the SKU's typical
 * (median) price — floored at $5 absolute, but ONLY for real-priced products
 * (median > $20). Cheap accessories are legitimately under $5 (bungees $0.50
 * on every real line, hooks $1.50), so for them the 20% rule stands alone.
 * Calibrated against real data: genuine discounted H9 sales bottom out around
 * 73% of median; the $1 placeholder mistakes sit at ~0.5%.
 */
export function lowPriceThreshold(medianPrice: number): number {
  return medianPrice > 20 ? Math.max(5, medianPrice * 0.2) : medianPrice * 0.2
}

export interface SuspiciousLine {
  index: number
  sku: string
  unitPrice: number
  /** Null when the SKU has no price history — flagged on the placeholder floor. */
  typicalPrice: number | null
}

/**
 * Lines priced below the threshold for a SKU we have real history on — plus,
 * when `mappedSkus` is provided, MAPPED product SKUs with NO history at all
 * priced at placeholder level (<= $5). Without that floor the guard is inert
 * for exactly the rarely-quoted NA products still carrying HubSpot's $1
 * placeholder (H9W had zero history rows when this shipped).
 */
export function findSuspiciousLines(
  items: { sku?: string; unitPrice: number }[],
  stats: Record<string, SkuPriceStatLike>,
  opts: { mappedSkus?: readonly string[] } = {}
): SuspiciousLine[] {
  const mapped = new Set(opts.mappedSkus ?? [])
  const flagged: SuspiciousLine[] = []
  items.forEach((item, index) => {
    const sku = (item.sku ?? '').trim()
    if (!sku) return
    const stat = stats[sku]
    if (stat) {
      if (item.unitPrice < lowPriceThreshold(stat.medianPrice)) {
        flagged.push({ index, sku, unitPrice: item.unitPrice, typicalPrice: stat.medianPrice })
      }
    } else if (mapped.has(sku) && item.unitPrice <= 5) {
      flagged.push({ index, sku, unitPrice: item.unitPrice, typicalPrice: null })
    }
  })
  return flagged
}
