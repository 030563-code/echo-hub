import { describe, it, expect } from 'vitest'
import {
  availabilityLabel,
  availabilityTone,
  factoryStatus,
  factoryStatusLabel,
  feedIsStale,
} from '@/lib/factory/status'
import { FACTORY_LOCALES } from '@/lib/factory/strings'

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

  it('has a label for every status, in every language', () => {
    for (const locale of FACTORY_LOCALES) {
      for (const status of ['awaiting_confirmation', 'confirmed', 'in_production', 'finished'] as const) {
        expect(factoryStatusLabel(status, locale), `${locale}/${status}`).toBeTruthy()
      }
    }
    // The first one is a question aimed at them, not a description of us.
    expect(factoryStatusLabel('awaiting_confirmation', 'en')).toBe('Awaiting your confirmation')
    expect(factoryStatusLabel('awaiting_confirmation', 'sk')).toBe('Čaká na vaše potvrdenie')
  })
})

describe('availabilityLabel', () => {
  it('translates the three words the feed actually carries', () => {
    // Live on 2026-09-16: skladom 62, vypredane 48, posledne_kusy 2.
    expect(availabilityLabel('skladom', 'en')).toBe('In stock')
    expect(availabilityLabel('vypredane', 'en')).toBe('Sold out')
    expect(availabilityLabel('posledne_kusy', 'en')).toBe('Last pieces')
  })

  it('gives the feed its own word back in Slovak, properly spelled', () => {
    expect(availabilityLabel('skladom', 'sk')).toBe('Skladom')
    expect(availabilityLabel('vypredane', 'sk')).toBe('Vypredané')
    expect(availabilityLabel('posledne_kusy', 'sk')).toBe('Posledné kusy')
  })

  it('passes anything else through rather than swallowing it', () => {
    // A new word from their system should be visible, not blank.
    for (const locale of FACTORY_LOCALES) {
      expect(availabilityLabel('nove_slovo', locale)).toBe('nove_slovo')
      expect(availabilityLabel(null, locale)).toBe('')
    }
    expect(availabilityLabel('  skladom  ', 'en')).toBe('In stock')
  })

  it('colours the row from the feed value, so the colour survives translation', () => {
    expect(availabilityTone('vypredane')).toBe('sold_out')
    expect(availabilityTone('posledne_kusy')).toBe('last_pieces')
    expect(availabilityTone('skladom')).toBe('normal')
    expect(availabilityTone(null)).toBe('normal')
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
