/**
 * A deal's close date, as the Hub sets it.
 *
 * Dean, 24 Sep 2026: "Okay add a close date field in the Hub please." Until then the only way to
 * move a close date was HubSpot, which is why 200 USA deals and 196 of Claire's sat past theirs.
 *
 * HubSpot keeps closedate as a date and time and shows it as a date in the viewer's own time zone.
 * Midnight UTC would read as the day before in every American office, so the Hub writes midday
 * UTC: the same calendar day from UTC-11 to UTC+11, and the same UTC date the past-close rule reads
 * (past-close.ts closeDay).
 *
 * Pure, so the deal page, the banner, the create-deal form and the action agree on one rule.
 */

import { closeDay } from '@/lib/past-close'

/** The earliest close date the Hub will write. Older ones are typing mistakes. */
export const EARLIEST_CLOSE_DAY = '2015-01-01'

/** How far ahead a close date may be set. A deal closing later than this is not a forecast. */
export const MAX_YEARS_AHEAD = 5

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/

/** The value HubSpot is sent for a calendar day: midday UTC. */
export function closeDateForHubSpot(day: string): string {
  return `${day}T12:00:00.000Z`
}

/** The day a date input starts on for a deal: its close date's UTC calendar day, or empty. */
export function closeDayForInput(closedate: string | null | undefined): string {
  return closeDay(closedate) ?? ''
}

/** Why a typed day cannot be a close date, or null when it can. */
export function closeDayProblem(day: string, nowMs: number): string | null {
  const value = String(day ?? '').trim()
  if (!DAY_RE.test(value)) return 'Pick a close date.'
  const ms = Date.parse(`${value}T00:00:00Z`)
  // "2026-02-30" parses to 2 March, so a real calendar day must read back as itself.
  if (Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 10) !== value) return 'That is not a real date.'
  if (value < EARLIEST_CLOSE_DAY) return `A close date cannot be before ${EARLIEST_CLOSE_DAY}.`
  const latest = new Date(nowMs)
  latest.setUTCFullYear(latest.getUTCFullYear() + MAX_YEARS_AHEAD)
  if (value > latest.toISOString().slice(0, 10)) return `A close date cannot be more than ${MAX_YEARS_AHEAD} years ahead.`
  return null
}

/** Today's UTC calendar day, the earliest a new close date for an overdue deal should be. */
export function todayUtc(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10)
}
