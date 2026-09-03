'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { LinkSpinner } from '@/components/nav/link-spinner'

/**
 * Sub-navigation for Pricing. The Discount caps tab is hidden from a read-only
 * viewer: a rep has no business seeing what every other rep is allowed to
 * discount. Its page checks pricing.manage for itself, so hiding the tab is
 * presentation and not the control.
 */
const TABS = [
  { href: '/pricing/list', label: 'List prices', manageOnly: false },
  { href: '/pricing/contracts', label: 'Contract prices', manageOnly: false },
  { href: '/pricing/caps', label: 'Discount caps', manageOnly: true },
] as const

export function PricingNav({ canManage }: { canManage: boolean }) {
  const pathname = usePathname()
  const tabs = TABS.filter((tab) => canManage || !tab.manageOnly)

  return (
    <nav aria-label="Pricing" className="mb-6 border-b border-gray-200">
      <ul className="flex flex-nowrap overflow-x-auto -mx-4 px-4 gap-x-1 -mb-px sm:mx-0 sm:px-0 sm:flex-wrap sm:overflow-visible">
        {tabs.map((tab) => {
          const active = pathname === tab.href || pathname.startsWith(`${tab.href}/`)
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
