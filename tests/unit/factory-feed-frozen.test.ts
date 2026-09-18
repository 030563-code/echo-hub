import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { FROZEN_FEED_DAYS, feedIsFrozen, feedIsStale } from '@/lib/factory/status'
import { strings } from '@/lib/factory/strings'

/**
 * Two different failures, two different questions. Stale: did the sync run.
 * Frozen: did the numbers move. The feed served identical values for six
 * weeks while the stale check stayed green (18 Sep 2026).
 */
describe('feedIsFrozen', () => {
  const now = Date.parse('2026-09-18T09:00:00Z')
  const days = (n: number) => new Date(now - n * 24 * 60 * 60 * 1000).toISOString()

  it('is frozen after a week without a single change', () => {
    expect(FROZEN_FEED_DAYS).toBe(7)
    expect(feedIsFrozen(days(8), now)).toBe(true)
    expect(feedIsFrozen(days(43), now)).toBe(true)
  })

  it('is not frozen while something moved this week', () => {
    expect(feedIsFrozen(days(1), now)).toBe(false)
    expect(feedIsFrozen(days(6), now)).toBe(false)
  })

  it('treats no change stamp at all as frozen, never as fresh', () => {
    expect(feedIsFrozen(null, now)).toBe(true)
    expect(feedIsFrozen('not a date', now)).toBe(true)
  })

  it('is independent of the sync stamp: a sync this morning does not thaw a frozen feed', () => {
    const syncedThisMorning = days(0.1)
    expect(feedIsStale(syncedThisMorning, now)).toBe(false)
    expect(feedIsFrozen(days(43), now)).toBe(true)
  })
})

describe('the factory stock page shows the change date, not the sync date', () => {
  const read = (f: string) => readFileSync(join(process.cwd(), f), 'utf8')

  it('warns on the screen but still refuses to email while the feed is frozen', () => {
    // 🔴 The screen SHOWS the figures under a banner naming the date; it used
    // to hide them, which shipped the feature invisible because the feed has
    // been frozen since 6 Aug. A person can judge a marked figure. The alert
    // still refuses, because nobody is there to read a warning on an email.
    const page = read('src/app/(dashboard)/factory/stock/page.tsx')
    expect(page).toContain('feedIsFrozen(newestChangeAt)')
    expect(page).toContain('const capability = await loadFactoryCapability(rows)')
    expect(page).not.toContain('frozen ? null :')
    expect(page).toContain('t.capabilityFrozen')
    const route = read('src/app/api/mrp/factory-alert/route.ts')
    expect(route).toContain("reason: 'feed_frozen'")
    // The alert route is a machine endpoint and has to be on the allowlist, or
    // the session middleware turns the nightly's POST into a login redirect
    // that reads as success.
    expect(read('src/middleware.ts')).toContain("'/api/mrp/factory-alert'")
  })

  it('prints the day the figures moved on every row', () => {
    const table = read('src/app/(dashboard)/factory/stock/factory-stock-table.tsx')
    expect(table).toContain("accessorKey: 'last_changed_at'")
  })

  it('says all of it in the manufacturer\'s language', () => {
    const sk = strings('sk')
    expect(sk.capabilityTitle).toBe('Čo dokážete vyrobiť')
    expect(sk.colCapability).toBe('Dokážete vyrobiť')
    expect(sk.colRequirement).toBe('Budeme potrebovať')
    expect(sk.capShort).toBe('Nedostatok materiálu')
    expect(sk.colShortBy).toBe('Chýba')
  })
})
