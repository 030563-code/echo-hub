import type { HubSpotSearchFilter } from '@/lib/deal-filters'

/**
 * Open deals whose close date has passed, by the CSO's rule.
 *
 * Dean, 23 Sep 2026: "whenever a sales person logs in under quotes there should be a red warning
 * on the top of the deals board across all tabs teling them they have deals open and past ecpiry
 * date that need fixing same thing the CSO looks at on CORTEX in the
 * cso-brain/scripts/crm-hygiene-check.mjs and other scripts in cso-brain/scripts".
 *
 * The CSO's rule, as crm-hygiene-check.mjs (check 2) and pastCloseRows in sales-desk-pack.mjs both
 * apply it: the deal is open, meaning hs_is_closed is false (never a list of stage ids: fifteen
 * pipelines close on their own ids), and the UTC calendar date of its closedate comes before
 * today's UTC date. As a HubSpot search that is a closedate strictly before today's UTC midnight,
 * so a close date of today is not past and one of yesterday at 23:59 is.
 *
 * Who is counted follows who is looking. A salesperson sees the deals they own, in every pipeline,
 * because those are the ones they can fix. An admin, who sees every rep on the board, sees every
 * open deal in the active organisation's pipeline, whoever owns it: Dean, 23 Sep 2026, looking at
 * USA as an admin and seeing Dave's own 2, "there should be alot more from the past" (there were
 * 200). The CSO reads the whole portal and routes each deal to a region, so an admin's count for
 * an organisation is that region's share of the CSO's.
 */

export const DAY_MS = 86_400_000

/** Today's UTC midnight: the first instant that is not past. */
export function startOfUtcDay(nowMs: number): number {
  return Math.floor(nowMs / DAY_MS) * DAY_MS
}

/** The UTC calendar date a HubSpot closedate falls on ("2026-09-22"), or null without one. */
export function closeDay(closedate: string | null | undefined): string | null {
  const value = String(closedate ?? '').trim()
  if (!/^\d{4}-\d{2}-\d{2}/.test(value)) return null
  const ms = Date.parse(value)
  return Number.isNaN(ms) ? null : new Date(ms).toISOString().slice(0, 10)
}

export function isPastClose(closedate: string | null | undefined, nowMs: number): boolean {
  const day = closeDay(closedate)
  return day !== null && day < new Date(nowMs).toISOString().slice(0, 10)
}

/** Whole UTC days since the close date: 1 for yesterday. Null when it has not passed. */
export function daysPastClose(closedate: string | null | undefined, nowMs: number): number | null {
  const day = closeDay(closedate)
  if (!day) return null
  const days = Math.round((startOfUtcDay(nowMs) - Date.parse(`${day}T00:00:00Z`)) / DAY_MS)
  return days > 0 ? days : null
}

/**
 * The CSO's order for its past-close list (cso-brain/scripts/crm-team-briefs.mjs): the largest
 * amount first, then the oldest close date. A deal with no amount sorts as zero, as it does there.
 */
export function byCsoOrder(
  a: { amount: number | null; closeDay: string },
  b: { amount: number | null; closeDay: string },
): number {
  return (b.amount ?? 0) - (a.amount ?? 0) || a.closeDay.localeCompare(b.closeDay)
}

/** The search for one owner's open deals past their close date. */
export function pastCloseFilters(ownerId: string, nowMs: number): HubSpotSearchFilter[] {
  return [
    { propertyName: 'hubspot_owner_id', operator: 'EQ', value: ownerId },
    { propertyName: 'hs_is_closed', operator: 'EQ', value: 'false' },
    { propertyName: 'closedate', operator: 'LT', value: String(startOfUtcDay(nowMs)) },
  ]
}

/** The search for every open deal in one pipeline past its close date, whoever owns it. */
export function pastCloseOrgFilters(pipelineId: string, nowMs: number): HubSpotSearchFilter[] {
  return [
    { propertyName: 'pipeline', operator: 'EQ', value: pipelineId },
    { propertyName: 'hs_is_closed', operator: 'EQ', value: 'false' },
    { propertyName: 'closedate', operator: 'LT', value: String(startOfUtcDay(nowMs)) },
  ]
}
