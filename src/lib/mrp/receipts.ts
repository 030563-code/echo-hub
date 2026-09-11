const MS_PER_DAY = 86_400_000

/**
 * Pure: shipped→delivered span in fractional days, for lead-time actuals.
 * Null when shippedAt is missing/unparseable, or the span is implausible
 * (<= 0, or >= 365 days — matches the mrp_lead_time_actuals days check).
 *
 * Column-type contract: the live shipped_at column is a Postgres `date`,
 * so PostgREST returns bare date-only strings ('2026-01-17'). ES Date.parse
 * treats date-only forms as UTC midnight, so spans against a full ISO
 * deliveredAt timestamp stay well-defined (fractional days).
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
