/**
 * Pure money/quote math helpers. No 'server-only' guard, safe to use on either
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
 * A single line's value, always DERIVED as quantity x unitPrice.
 *
 * The client-supplied `total` is deliberately ignored. It used to be preferred
 * when present, which meant a crafted request could pass validateLineItems on a
 * sane quantity and unit price while naming any line total it liked. That total
 * reaches the deal amount, the stored row and the Xero/MCS webhook payload.
 * HubSpot derives its own amount from price x quantity and is never sent a
 * total, so deriving here also keeps the two sides in agreement.
 *
 * There is no discount concept in the builder; if one is ever added, it belongs
 * here rather than in a value the browser hands over.
 */
export function computeLineTotal(item: QuoteLineItemLike | null | undefined): number {
  return roundCents(toMoney(item?.quantity) * toMoney(item?.unitPrice))
}

/** Sum a list of line items to a cents-rounded grand total. Never returns NaN. */
export function computeLineItemsTotal(lineItems: readonly QuoteLineItemLike[] | null | undefined): number {
  if (!Array.isArray(lineItems)) return 0
  return roundCents(lineItems.reduce((acc, item) => acc + computeLineTotal(item), 0))
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
