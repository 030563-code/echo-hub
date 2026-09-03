'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { LinkSpinner } from '@/components/nav/link-spinner'
import { INVOICE_STAGES } from '@/lib/customer-invoice/constants'

/**
 * One tab per step of the pipeline, in Dean's words (2026-09-03).
 *
 * These are a worklist, not a filter. An invoice sits under exactly one tab,
 * and completing that step is what moves it out of this queue and into the
 * next, so whatever is in a tab is waiting for the thing the tab is named
 * after. The stage tabs come from INVOICE_STAGES so the nav and the queue
 * pages cannot describe the pipeline differently.
 *
 * Accepted Quotes sits first because it is the only one that is not a status:
 * it is the deals that have no invoice yet, plus any that were opened but not
 * yet taxed. Tax Setup sits last because it is configuration, not a queue.
 */
const TABS = [
  { href: '/invoicing/accepted', label: 'Accepted Quotes' },
  ...INVOICE_STAGES.map((stage) => ({ href: stage.href, label: stage.label })),
  { href: '/invoicing/tax-setup', label: 'Tax Setup' },
]

export function InvoicingNav() {
  const pathname = usePathname()

  return (
    <nav aria-label="Invoicing" className="mb-6 border-b border-gray-200">
      <ul className="flex flex-nowrap overflow-x-auto -mx-4 px-4 gap-x-1 -mb-px sm:mx-0 sm:px-0 sm:flex-wrap sm:overflow-visible">
        {TABS.map((tab) => {
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
