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
