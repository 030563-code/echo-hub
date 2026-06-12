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
