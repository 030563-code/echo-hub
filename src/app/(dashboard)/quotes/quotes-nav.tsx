'use client'

import { useEffect, useRef } from 'react'
import Link from 'next/link'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { LinkSpinner } from '@/components/nav/link-spinner'
import { usePageState } from '@/hooks/use-page-state'
import {
  QUOTES_FILTERS_KEY,
  RESTORABLE_QUOTE_PARAMS,
  hasAnyRestorableParam,
  isQuotesListRoute,
  parseQuotesFilters,
  pickRestorableParams,
  type QuotesFilters,
} from '@/lib/page-drafts'

/**
 * Sub-navigation for the Quotes module.
 *
 * Every one of these screens was already built and authorized, but only
 * /quotes/deals was reachable — the sidebar has a single "Quotes" entry and
 * /quotes redirects to the requests queue. Submitting a quote moves the deal OUT
 * of the requests queue and into Sent, so without this a rep generated a quote
 * and then had no way to look at it. Presentation only; each page still does its
 * own capability check.
 *
 * The scope and the filters travel with the tab. Dean: "when I am on the admin
 * page the USA sales and All reps filter doesn't carry over to the Deals".
 * Paging is deliberately NOT carried: a cursor belongs to the result set it
 * came from, so page 4 of Sent is meaningless on Won.
 */

/** Dropped when moving tab, because they are meaningless on the next one. */
const PER_TAB_PARAMS = new Set(['page', 'cursors'])
const TABS = [
  { href: '/quotes/board', label: 'Board' },
  { href: '/quotes/deals', label: 'Deals' },
  { href: '/quotes/sent', label: 'Sent' },
  { href: '/quotes/accepted', label: 'Accepted' },
  { href: '/quotes/won', label: 'Won' },
  { href: '/quotes/all', label: 'All' },
] as const

export function QuotesNav() {
  const pathname = usePathname()
  const router = useRouter()
  const searchParams = useSearchParams()

  const carried = new URLSearchParams()
  for (const [name, value] of searchParams.entries()) {
    if (!PER_TAB_PARAMS.has(name)) carried.append(name, value)
  }
  const query = carried.toString()
  const withFilters = (href: string) => (query ? `${href}?${query}` : href)

  // Remember the filter set, so arriving at a bare /quotes/board from the
  // sidebar puts back what was last being looked at.
  //
  // Written ONLY from the six list routes, by exact path. This component is
  // rendered by the layout that wraps the entire /quotes/* subtree, so without
  // that test opening a deal or the quote builder would record their empty
  // parameter set over the filters the rep had just built. That is the most
  // common click in the module, so it would have looked like the feature simply
  // did not work.
  const onListRoute = isQuotesListRoute(pathname)
  /** Did this URL ask for something specific? If so it is obeyed, not recorded
   *  over and not overridden. A bare URL is an arrival, not a choice. */
  const explicit = hasAnyRestorableParam(searchParams, RESTORABLE_QUOTE_PARAMS)

  const { restored: restoredFilters, save: saveFilters } = usePageState<QuotesFilters>({
    pageKey: QUOTES_FILTERS_KEY,
    parse: parseQuotesFilters,
    // Only a deliberate view is worth recording. Writing on a bare arrival
    // would blank the row a moment before it is read back.
    enabled: onListRoute && explicit,
    isEmpty: (stored) => Object.keys(stored.params).length === 0,
  })

  useEffect(() => {
    if (!onListRoute || !explicit) return
    const params: Record<string, string | string[]> = {}
    for (const [name, value] of carried.entries()) {
      const existing = params[name]
      if (existing === undefined) params[name] = value
      else if (Array.isArray(existing)) existing.push(value)
      else params[name] = [existing, value]
    }
    saveFilters({ v: 1, params })
    // `query` is the serialised form of `carried`, so it changes exactly when
    // the parameters do.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onListRoute, explicit, saveFilters, query])

  /**
   * Put the last-used filters back on a bare arrival.
   *
   * Done HERE, in an effect, and NOT with a redirect() in the page.
   *
   * A redirect on one of these routes fires during Next's PREFETCH of any link
   * pointing at it, and the router follows that redirect as though the user had
   * asked for it. The visible symptom was being on a deal, clicking Invoicing,
   * arriving at /invoicing/accepted, and then being thrown to /quotes/board:
   * the sidebar had merely prefetched /quotes, which redirects to /quotes/board,
   * which then redirected again. An effect never runs during a prefetch, so it
   * cannot do that.
   *
   * `replace`, not `push`, so Back still leaves the section instead of bouncing
   * off the bare url it just came from.
   */
  const restoredRef = useRef(false)
  useEffect(() => {
    if (!onListRoute || explicit || restoredRef.current) return
    const next = pickRestorableParams(restoredFilters?.data ?? null, RESTORABLE_QUOTE_PARAMS)
    if (!next) return
    restoredRef.current = true
    router.replace(`${pathname}?${next}`)
  }, [onListRoute, explicit, restoredFilters, pathname, router])

  return (
    <nav aria-label="Quotes" className="mb-6 border-b border-gray-200">
      <ul className="flex flex-nowrap overflow-x-auto -mx-4 px-4 gap-x-1 -mb-px sm:mx-0 sm:px-0 sm:flex-wrap sm:overflow-visible">
        {TABS.map((tab) => {
          // Exact match, or a child route (e.g. /quotes/deals/123).
          const active = pathname === tab.href || pathname.startsWith(`${tab.href}/`)
          return (
            <li key={tab.href} className="shrink-0">
              <Link
                href={withFilters(tab.href)}
                aria-current={active ? 'page' : undefined}
                className={
                  active
                    ? 'flex items-center gap-1.5 whitespace-nowrap min-h-11 sm:min-h-0 border-b-2 border-echo-yellow px-4 py-2.5 text-sm font-semibold text-gray-900'
                    : 'flex items-center gap-1.5 whitespace-nowrap min-h-11 sm:min-h-0 border-b-2 border-transparent px-4 py-2.5 text-sm font-medium text-gray-500 hover:border-gray-300 hover:text-gray-800'
                }
              >
                {/* useLinkStatus must be a child of Link, hence the separate LinkSpinner component */}
                {tab.label}
                <LinkSpinner />
              </Link>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}
