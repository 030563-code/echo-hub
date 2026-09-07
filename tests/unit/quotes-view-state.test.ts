import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  NEVER_RESTORED_PARAMS,
  hasAnyRestorableParam,
  QUOTES_LIST_ROUTES,
  RESTORABLE_QUOTE_PARAMS,
  isQuotesListRoute,
  parseQuotesFilters,
  pickRestorableParams,
} from '@/lib/page-drafts'
import { DEAL_FILTER_PARAMS } from '@/lib/deal-filters'

const filters = (params: Record<string, string | string[]>) => ({ v: 1 as const, params })

describe('which routes may record the filter set', () => {
  it('accepts the six list routes', () => {
    for (const route of QUOTES_LIST_ROUTES) expect(isQuotesListRoute(route), route).toBe(true)
  })

  it('refuses everything else under /quotes', () => {
    // The whole point: QuotesNav is rendered by the layout wrapping all of
    // /quotes/*, and these routes carry no filters. Recording from them would
    // blank the saved set on the most common click in the module.
    for (const route of [
      '/quotes',
      '/quotes/deals/12345',
      '/quotes/create/12345',
      '/quotes/create/manual',
      '/quotes/requests',
      '/quotes/pending',
      '/quotes/board/',
      '/quotes/boardroom',
    ]) {
      expect(isQuotesListRoute(route), route).toBe(false)
    }
  })

  it('covers every tab the nav actually renders', () => {
    // Drift guard: a seventh tab added to the nav without adding it here would
    // silently stop recording on that tab.
    const nav = readFileSync(
      join(process.cwd(), 'src/app/(dashboard)/quotes/quotes-nav.tsx'),
      'utf8',
    )
    const hrefs = [...nav.matchAll(/href: '([^']+)'/g)].map((m) => m[1])
    expect(hrefs.sort()).toEqual([...QUOTES_LIST_ROUTES].sort())
  })
})

describe('what a saved view may put back', () => {
  it('accepts every filter the bar owns', () => {
    for (const param of Object.values(DEAL_FILTER_PARAMS)) {
      expect(RESTORABLE_QUOTE_PARAMS as readonly string[], param).toContain(param)
    }
  })

  it('carries the page-owned choices too', () => {
    // Dean: "when I am on the admin page the USA sales and All reps filter
    // doesn't carry over to the Deals."
    for (const param of ['scope', 'pipeline', 'window']) {
      expect(RESTORABLE_QUOTE_PARAMS as readonly string[], param).toContain(param)
    }
  })

  it('never restores paging', () => {
    const query = pickRestorableParams(
      filters({ q: 'herc', page: '4', cursors: 'abc,def' }),
      [...RESTORABLE_QUOTE_PARAMS, 'page', 'cursors'],
    )
    // A cursor belongs to the result set it came from. Restoring page 4 lands
    // someone on rows that have since moved, which reads as data loss.
    expect(query).toBe('q=herc')
    for (const param of NEVER_RESTORED_PARAMS) expect(query).not.toContain(param)
  })

  it('keeps repeated parameters repeated', () => {
    const query = pickRestorableParams(filters({ stages: ['a', 'b'] }), RESTORABLE_QUOTE_PARAMS)
    expect(query).toBe('stages=a&stages=b')
  })

  it('drops anything not on the list, so a future row cannot redirect anywhere odd', () => {
    expect(pickRestorableParams(filters({ evil: 'x' }), RESTORABLE_QUOTE_PARAMS)).toBeNull()
  })

  it('returns null when there is nothing to restore', () => {
    expect(pickRestorableParams(null, RESTORABLE_QUOTE_PARAMS)).toBeNull()
    expect(pickRestorableParams(filters({}), RESTORABLE_QUOTE_PARAMS)).toBeNull()
  })

  it('treats an unreadable row as no row', () => {
    expect(parseQuotesFilters({ v: 2, params: {} })).toBeNull()
    expect(parseQuotesFilters('nonsense')).toBeNull()
    expect(parseQuotesFilters({ v: 1, params: { q: 5 } })).toBeNull()
  })
})

describe('a URL that asks for something specific is obeyed', () => {
  it('spots an explicit parameter, whatever its shape', () => {
    expect(hasAnyRestorableParam({ scope: 'mine' }, RESTORABLE_QUOTE_PARAMS)).toBe(true)
    expect(hasAnyRestorableParam({ stages: ['a'] }, RESTORABLE_QUOTE_PARAMS)).toBe(true)
    expect(hasAnyRestorableParam(new URLSearchParams('q=herc'), RESTORABLE_QUOTE_PARAMS)).toBe(true)
  })

  it('treats a bare url as an arrival, not a choice', () => {
    expect(hasAnyRestorableParam({}, RESTORABLE_QUOTE_PARAMS)).toBe(false)
    expect(hasAnyRestorableParam(new URLSearchParams(''), RESTORABLE_QUOTE_PARAMS)).toBe(false)
    // Paging alone is not a filter choice.
    expect(hasAnyRestorableParam({ page: '3' }, RESTORABLE_QUOTE_PARAMS)).toBe(false)
    // Nor is an empty value.
    expect(hasAnyRestorableParam({ scope: '' }, RESTORABLE_QUOTE_PARAMS)).toBe(false)
  })
})

describe('one click may change the url only once', () => {
  it('the filter restore rides the index redirect, and nothing else moves the url', () => {
    // Two shapes of this both crashed Next's own client Router with "Rendered
    // more hooks than during the previous render", which the browser shows as
    // "This page couldn't load. Reload to try again, or go back.":
    //
    //   /quotes -> /quotes/board -> /quotes/board?scope=mine   (two redirects)
    //   /quotes -> /quotes/board, then router.replace(?scope=mine)
    //
    // Both changed the url twice for one click. Only /quotes may redirect, and
    // it must carry the filters itself so there is no second hop.
    for (const file of [
      'src/app/(dashboard)/quotes/board/page.tsx',
      'src/app/(dashboard)/quotes/all/page.tsx',
      'src/app/(dashboard)/quotes/stage-queue.tsx',
    ]) {
      const source = readFileSync(join(process.cwd(), file), 'utf8')
      expect(source, file).not.toContain('restoreViewParams')
      expect(source, file).not.toMatch(/^\s*redirect\(/m)
    }

    // The tab bar records filters; it must never navigate.
    const nav = readFileSync(join(process.cwd(), 'src/app/(dashboard)/quotes/quotes-nav.tsx'), 'utf8')
    expect(nav).not.toContain('useRouter')
    expect(nav).not.toMatch(/router\.(replace|push)\(/)

    // The index redirect is the one url change a Quotes click is allowed, and
    // it must stay synchronous: an await here makes Next answer with an
    // in-stream client redirect that never lands.
    const index = readFileSync(join(process.cwd(), 'src/app/(dashboard)/quotes/page.tsx'), 'utf8')
    expect(index.match(/^\s*redirect\(/gm) ?? []).toHaveLength(1)
    expect(index).not.toContain('await')
    expect(index).not.toContain('async')

    // The restore itself never touches the url.
    for (const file of [
      'src/app/(dashboard)/quotes/board/page.tsx',
      'src/app/(dashboard)/quotes/all/page.tsx',
      'src/app/(dashboard)/quotes/stage-queue.tsx',
    ]) {
      const source = readFileSync(join(process.cwd(), file), 'utf8')
      expect(source, file).toContain('withStoredQuotesFilters')
    }
  })
})

describe('Clear stays escapable', () => {
  it('both queue pages send the scope with Clear, even at its default', () => {
    // Clear builds its href from `hidden`. With no recognised parameter in it,
    // Clear looks exactly like a bare arrival to the restore, which would
    // redirect the user straight back to the filters they just cleared.
    for (const file of [
      'src/app/(dashboard)/quotes/all/page.tsx',
      'src/app/(dashboard)/quotes/stage-queue.tsx',
    ]) {
      const source = readFileSync(join(process.cwd(), file), 'utf8')
      expect(source, file).toContain('hidden={{ scope }}')
    }
  })
})
