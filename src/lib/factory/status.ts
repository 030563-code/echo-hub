/**
 * Where one order stands, in the manufacturer's own words.
 *
 * Deliberately not deriveStage from po-lifecycle.ts. That one answers "which
 * column of our board", needs the leg and the status, and speaks our vocabulary
 * (sro, sent_manufacturing, ready_for_shipment). The factory is looking at
 * their own work list: what have I not answered yet, what have I promised, what
 * am I building, what is done.
 *
 * Pure, so the test can pin the day boundary instead of racing it.
 */

export type FactoryStatus = 'awaiting_confirmation' | 'confirmed' | 'in_production' | 'finished'

export const FACTORY_STATUS_LABELS: Record<FactoryStatus, string> = {
  awaiting_confirmation: 'Awaiting your confirmation',
  confirmed: 'Confirmed',
  in_production: 'In production',
  finished: 'Finished',
}

export interface FactoryOrderProgress {
  confirmed_at: string | null
  est_start: string | null
  finished_at: string | null
}

/**
 * `today` is a yyyy-mm-dd string in UTC, the same shape est_start is stored in,
 * so the comparison is a plain string compare and never a timezone argument.
 */
export function factoryStatus(
  m: FactoryOrderProgress,
  today: string = new Date().toISOString().slice(0, 10),
): FactoryStatus {
  if (m.finished_at) return 'finished'
  // Dates alone do not mean the order is accepted: an order can carry a start
  // date from a confirmation that was never completed, and until they press
  // Confirm we have not been told anything.
  if (!m.confirmed_at) return 'awaiting_confirmation'
  if (m.est_start && m.est_start <= today) return 'in_production'
  return 'confirmed'
}

/**
 * The feed's availability word, in English.
 *
 * Three values are live today (skladom 62, vypredane 48, posledne_kusy 2 on
 * 2026-09-16). Anything else passes through rather than being swallowed: a new
 * word from their system should be visible, not silently blank.
 */
export function availabilityLabel(availability: string | null): string {
  switch ((availability ?? '').trim()) {
    case 'skladom':
      return 'In stock'
    case 'vypredane':
      return 'Sold out'
    case 'posledne_kusy':
      return 'Last pieces'
    default:
      return (availability ?? '').trim()
  }
}

/** The sync runs daily at 06:00 London, so a day and a bit is the alarm. */
export const STALE_FEED_HOURS = 26

export function feedIsStale(newestSyncAt: string | null, now: number = Date.now()): boolean {
  if (!newestSyncAt) return true
  const synced = new Date(newestSyncAt).getTime()
  if (!Number.isFinite(synced)) return true
  return now - synced > STALE_FEED_HOURS * 60 * 60 * 1000
}
