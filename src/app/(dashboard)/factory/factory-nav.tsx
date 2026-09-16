'use client'

// page-state: none (tabs are the URL)

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { LinkSpinner } from '@/components/nav/link-spinner'

const TABS = [
  { href: '/factory', label: 'Manufacturing' },
  { href: '/factory/stock', label: 'Stock' },
] as const

/** The same sub-navigation bar Stock, Pricing and Invoicing use. */
export function FactoryNav() {
  const pathname = usePathname()
  return (
    <nav aria-label="Factory" className="mb-6 border-b border-gray-200">
      <ul className="flex flex-nowrap overflow-x-auto -mx-4 px-4 gap-x-1 -mb-px sm:mx-0 sm:px-0 sm:flex-wrap sm:overflow-visible">
        {TABS.map((tab) => {
          // Longest match, so an order page keeps Manufacturing lit and
          // /factory/stock does not light both.
          const active =
            tab.href === '/factory'
              ? pathname === '/factory' || (pathname.startsWith('/factory/') && pathname !== '/factory/stock')
              : pathname === tab.href
          return (
            <li key={tab.href} className="shrink-0">
              <Link
                href={tab.href}
                aria-current={active ? 'page' : undefined}
                className={
                  active
                    ? 'flex items-center gap-1.5 whitespace-nowrap min-h-11 sm:min-h-0 border-b-2 border-echo-yellow px-4 py-2.5 text-sm font-semibold text-gray-900'
                    : 'flex items-center gap-1.5 whitespace-nowrap min-h-11 sm:min-h-0 border-b-2 border-transparent px-4 py-2.5 text-sm font-medium text-gray-500 hover:border-gray-300 hover:text-gray-800'
                }
              >
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
