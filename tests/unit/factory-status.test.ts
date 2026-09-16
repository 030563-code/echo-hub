import { describe, it, expect } from 'vitest'
import {
  FACTORY_STATUS_LABELS,
  availabilityLabel,
  factoryStatus,
  feedIsStale,
} from '@/lib/factory/status'

/**
 * The manufacturer's own view of where an order stands.
 *
 * Pure, so the day boundary is pinned rather than raced: a test that called
 * new Date() would pass all day and fail once at midnight in whichever zone the
 * machine happens to be in.
 */

const TODAY = '2026-09-16'

describe('factoryStatus', () => {
  it('starts at awaiting confirmation, whatever dates are sitting on the row', () => {
    expect(factoryStatus({ confirmed_at: null, est_start: null, finished_at: null }, TODAY)).toBe(
      'awaiting_confirmation',
    )
    // Dates alone are not an answer. Until they press Confirm we have not been
    // told they are taking the order on, so a start date in the past must not
    // read as "in production".
    expect(factoryStatus({ confirmed_at: null, est_start: '2026-09-01', finished_at: null }, TODAY)).toBe(
      'awaiting_confirmation',
    )
  })

  it('is confirmed while the start date is still ahead', () => {
    expect(
      factoryStatus({ confirmed_at: '2026-09-16T08:00:00Z', est_start: '2026-09-20', finished_at: null }, TODAY),
    ).toBe('confirmed')
  })

  it('is in production from the start date onwards, inclusive', () => {
    expect(
      factoryStatus({ confirmed_at: '2026-09-16T08:00:00Z', est_start: TODAY, finished_at: null }, TODAY),
    ).toBe('in_production')
    expect(
      factoryStatus({ confirmed_at: '2026-09-16T08:00:00Z', est_start: '2026-09-01', finished_at: null }, TODAY),
    ).toBe('in_production')
  })

  it('is finished the moment the timestamp exists, whatever else is set', () => {
    expect(
      factoryStatus({ confirmed_at: null, est_start: '2026-12-01', finished_at: '2026-09-16T10:00:00Z' }, TODAY),
    ).toBe('finished')
  })

  it('has a label for every status', () => {
    for (const status of ['awaiting_confirmation', 'confirmed', 'in_production', 'finished'] as const) {
      expect(FACTORY_STATUS_LABELS[status]).toBeTruthy()
    }
    // The first one is a question aimed at them, not a description of us.
    expect(FACTORY_STATUS_LABELS.awaiting_confirmation).toBe('Awaiting your confirmation')
  })
})

describe('availabilityLabel', () => {
  it('translates the three words the feed actually carries', () => {
    // Live on 2026-09-16: skladom 62, vypredane 48, posledne_kusy 2.
    expect(availabilityLabel('skladom')).toBe('In stock')
    expect(availabilityLabel('vypredane')).toBe('Sold out')
    expect(availabilityLabel('posledne_kusy')).toBe('Last pieces')
  })

  it('passes anything else through rather than swallowing it', () => {
    // A new word from their system should be visible, not blank.
    expect(availabilityLabel('nove_slovo')).toBe('nove_slovo')
    expect(availabilityLabel(null)).toBe('')
    expect(availabilityLabel('  skladom  ')).toBe('In stock')
  })
})

describe('feedIsStale', () => {
  const now = Date.parse('2026-09-16T12:00:00Z')

  it('is fresh through a normal night, and stale when a run is missed', () => {
    // The sync runs daily at 06:00 London, so a day and a bit is the alarm.
    expect(feedIsStale('2026-09-15T11:00:00Z', now)).toBe(false) // 25 hours
    expect(feedIsStale('2026-09-15T09:00:00Z', now)).toBe(true) // 27 hours
  })

  it('treats no figure and an unreadable one as stale', () => {
    expect(feedIsStale(null, now)).toBe(true)
    expect(feedIsStale('not a date', now)).toBe(true)
  })
})
