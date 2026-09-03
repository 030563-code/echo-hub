'use client'

import Link from 'next/link'
import { usePathname, useSearchParams } from 'next/navigation'
import { LinkSpinner } from '@/components/nav/link-spinner'

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
  const searchParams = useSearchParams()

  const carried = new URLSearchParams()
  for (const [name, value] of searchParams.entries()) {
    if (!PER_TAB_PARAMS.has(name)) carried.append(name, value)
  }
  const query = carried.toString()
  const withFilters = (href: string) => (query ? `${href}?${query}` : href)

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
