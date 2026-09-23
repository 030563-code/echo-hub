'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { LinkSpinner } from '@/components/nav/link-spinner'

/**
 * Shipments and Customs, for the one person who handles customs bills.
 *
 * Dean, 23 Sep 2026: "a new tab maybe under transport where only Dave can see it". Everyone else
 * sees Transport exactly as before, with no tab bar at all, so nobody is shown the name of a
 * screen they cannot open. Shown on the two list screens only: a shipment page has its own way
 * back.
 */

const TABS = [
  { href: '/transport', label: 'Shipments', exact: true },
  { href: '/transport/customs', label: 'Customs', exact: false },
] as const

export function TransportTabs({ showCustoms }: { showCustoms: boolean }) {
  const pathname = usePathname()
  if (!showCustoms) return null
  const onList = pathname === '/transport' || pathname === '/transport/customs' || pathname.startsWith('/transport/customs/')
  if (!onList) return null

  return (
    <nav aria-label="Transport" className="border-b border-gray-200 px-6 pt-4">
      <ul className="-mb-px flex gap-x-1">
        {TABS.map((tab) => {
          const active = tab.exact ? pathname === tab.href : pathname === tab.href || pathname.startsWith(`${tab.href}/`)
          return (
            <li key={tab.href}>
              <Link
                href={tab.href}
                aria-current={active ? 'page' : undefined}
                className={
                  active
                    ? 'flex items-center gap-1.5 whitespace-nowrap border-b-2 border-echo-yellow px-4 py-2.5 text-sm font-semibold text-gray-900'
                    : 'flex items-center gap-1.5 whitespace-nowrap border-b-2 border-transparent px-4 py-2.5 text-sm font-medium text-gray-500 hover:border-gray-300 hover:text-gray-800'
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
