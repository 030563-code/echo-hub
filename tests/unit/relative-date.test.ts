import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'

// The board's router is only used when a card is dropped, never to render.
vi.mock('next/navigation', () => ({ useRouter: () => ({ push() {}, refresh() {} }) }))

import { formatDate, formatRelative } from '@/lib/utils'
import { RelativeDate } from '@/components/ui/relative-date'
import { DealsBoard } from '@/components/quotes/deals-board'
import type { HubSpotDeal } from '@/lib/hubspot-types'

/**
 * The Quotes board threw React's hydration error (418) on the live Hub for
 * everyone: formatRelative read the clock and the process zone while
 * rendering, and a deal created late in the evening fell on a different day on
 * the server (UTC) than in the browser. What the first render shows must depend
 * on neither.
 */

// 02:30 UTC on 27 June is still the evening of 26 June in Chicago.
const LATE_EVENING_IN_CHICAGO = '2022-06-27T02:30:00Z'
const ZONES = ['UTC', 'America/Chicago', 'Europe/Paris', 'Asia/Tokyo']

const originalTZ = process.env.TZ
afterAll(() => {
  if (originalTZ === undefined) delete process.env.TZ
  else process.env.TZ = originalTZ
})
afterEach(() => {
  vi.useRealTimers()
})

/** Runs `fn` with the whole process in `zone`, the way a server in that zone would. */
function inProcessZone<T>(zone: string, fn: () => T): T {
  process.env.TZ = zone
  return fn()
}

describe('the process zone really changes between runs', () => {
  it('moves the date of a timestamp formatted with no zone named, so the comparisons below are not vacuous', () => {
    expect(inProcessZone('UTC', () => formatDate(LATE_EVENING_IN_CHICAGO))).toBe('June 27, 2022')
    expect(inProcessZone('America/Chicago', () => formatDate(LATE_EVENING_IN_CHICAGO))).toBe('June 26, 2022')
  })
})

describe('formatRelative before the reader is known', () => {
  it('gives the same text whatever zone the process is in', () => {
    const texts = ZONES.map((zone) => inProcessZone(zone, () => formatRelative(LATE_EVENING_IN_CHICAGO, null)))
    expect(texts).toEqual(ZONES.map(() => 'June 27, 2022'))
  })

  it('gives the same text whatever the clock says, because it does not read it', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const created = '2026-09-20T12:00:00Z'
    vi.setSystemTime(new Date('2026-09-20T13:00:00Z'))
    const anHourLater = formatRelative(created, null)
    vi.setSystemTime(new Date('2026-11-02T13:00:00Z'))
    const weeksLater = formatRelative(created, null)
    expect(anHourLater).toBe('September 20, 2026')
    expect(weeksLater).toBe(anHourLater)
  })
})

describe('formatRelative once the reader is known', () => {
  it('says how long ago', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-09-24T12:00:00Z'))
    expect(formatRelative('2026-09-24T09:00:00Z', 'America/Chicago')).toBe('Today')
    expect(formatRelative('2026-09-23T09:00:00Z', 'America/Chicago')).toBe('Yesterday')
    expect(formatRelative('2026-09-21T09:00:00Z', 'America/Chicago')).toBe('3d ago')
    expect(formatRelative('2026-09-10T09:00:00Z', 'America/Chicago')).toBe('2w ago')
  })

  it("gives an older date on the reader's own calendar, whatever zone the process is in", () => {
    for (const zone of ZONES) {
      inProcessZone(zone, () => {
        expect(formatRelative(LATE_EVENING_IN_CHICAGO, 'America/Chicago'), zone).toBe('June 26, 2022')
        expect(formatRelative(LATE_EVENING_IN_CHICAGO, 'Europe/Paris'), zone).toBe('June 27, 2022')
      })
    }
  })

  it('keeps a date-only value on its own day in every zone, as formatDate always has', () => {
    for (const zone of ZONES) {
      inProcessZone(zone, () => {
        expect(formatRelative('2022-06-26', 'America/Chicago'), zone).toBe('June 26, 2022')
        expect(formatRelative('2022-06-26', null), zone).toBe('June 26, 2022')
        expect(formatDate('2022-06-26', 'Asia/Tokyo'), zone).toBe('June 26, 2022')
      })
    }
  })
})

describe('what the server renders', () => {
  it('is the same RelativeDate whatever zone the server runs in', () => {
    const html = ZONES.map((zone) =>
      inProcessZone(zone, () => renderToString(createElement(RelativeDate, { value: LATE_EVENING_IN_CHICAGO }))),
    )
    expect(html).toEqual(ZONES.map(() => 'June 27, 2022'))
  })

  it('is the same Quotes board whatever zone the server runs in', () => {
    const deal: HubSpotDeal = {
      id: 'deal-1',
      properties: {
        dealname: 'Invented deal',
        amount: '1000',
        createdate: LATE_EVENING_IN_CHICAGO,
        dealstage: 'stage-1',
        pipeline: 'pipeline-1',
        deal_currency_code: 'USD',
      },
    }
    const board = createElement(DealsBoard, {
      groups: [{ column: { stageId: 'stage-1', label: 'Invented stage', stageKey: 'INVENTED' }, deals: [deal] }],
      showOwner: false,
    })
    const html = ZONES.map((zone) => inProcessZone(zone, () => renderToString(board)))
    for (const other of html.slice(1)) expect(other).toBe(html[0])
    expect(html[0]).toContain('June 27, 2022')
  })
})
