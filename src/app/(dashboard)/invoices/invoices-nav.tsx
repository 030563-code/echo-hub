'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { LinkSpinner } from '@/components/nav/link-spinner'

/**
 * Sub-navigation for Invoices, the same bar Stock, Pricing and Invoicing use.
 *
 * Commercial invoices is the root route, so it is active only on /invoices
 * itself: every other invoices route starts with /invoices/ too.
 */
const TABS = [
  { href: '/invoices', label: 'Commercial invoices', exact: true },
  { href: '/invoices/hs-codes', label: 'HS codes', exact: false },
] as const

export function InvoicesNav() {
  const pathname = usePathname()
  return (
    <nav aria-label="Invoices" className="mb-6 border-b border-gray-200">
      <ul className="flex flex-nowrap overflow-x-auto -mx-4 px-4 gap-x-1 -mb-px sm:mx-0 sm:px-0 sm:flex-wrap sm:overflow-visible">
        {TABS.map((tab) => {
          const active = tab.exact ? pathname === tab.href : pathname === tab.href || pathname.startsWith(`${tab.href}/`)
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
