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

import { strings, type FactoryLocale } from './strings'

export type FactoryStatus = 'awaiting_confirmation' | 'confirmed' | 'in_production' | 'finished'

/** The status in the manufacturer's language. */
export function factoryStatusLabel(status: FactoryStatus, locale: FactoryLocale): string {
  const t = strings(locale)
  switch (status) {
    case 'awaiting_confirmation':
      return t.statusAwaitingConfirmation
    case 'confirmed':
      return t.statusConfirmed
    case 'in_production':
      return t.statusInProduction
    case 'finished':
      return t.statusFinished
  }
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
 * The feed's availability word, in the reader's language.
 *
 * Three values are live today (skladom 62, vypredane 48, posledne_kusy 2 on
 * 2026-09-16), and they arrive from their system in Slovak already. Anything
 * else passes through rather than being swallowed: a new word from their system
 * should be visible, not silently blank.
 */
export function availabilityLabel(availability: string | null, locale: FactoryLocale): string {
  const t = strings(locale)
  switch ((availability ?? '').trim()) {
    case 'skladom':
      return t.availabilityInStock
    case 'vypredane':
      return t.availabilitySoldOut
    case 'posledne_kusy':
      return t.availabilityLastPieces
    default:
      return (availability ?? '').trim()
  }
}

export type AvailabilityTone = 'sold_out' | 'last_pieces' | 'normal'

/**
 * How to colour that word. Keyed off the FEED's value, never off the label:
 * comparing the rendered text to "Sold out" quietly lost its colour the moment
 * the same row was rendered in Slovak.
 */
export function availabilityTone(availability: string | null): AvailabilityTone {
  switch ((availability ?? '').trim()) {
    case 'vypredane':
      return 'sold_out'
    case 'posledne_kusy':
      return 'last_pieces'
    default:
      return 'normal'
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
