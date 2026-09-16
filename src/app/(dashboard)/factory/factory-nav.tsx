'use client'

// page-state: none (tabs are the URL, and the language is a cookie)

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { LinkSpinner } from '@/components/nav/link-spinner'
import { FACTORY_LOCALES, FACTORY_LOCALE_NAMES, strings, type FactoryLocale } from '@/lib/factory/strings'

/** The same sub-navigation bar Stock, Pricing and Invoicing use, plus the
 *  language switch, because these two tabs are the only ones translated. */
export function FactoryNav({ locale }: { locale: FactoryLocale }) {
  const pathname = usePathname()
  const t = strings(locale)
  const tabs = [
    { href: '/factory', label: t.navManufacturing },
    { href: '/factory/stock', label: t.navStock },
  ]

  return (
    <nav aria-label="Factory" className="mb-6 flex items-end justify-between gap-4 border-b border-gray-200">
      <ul className="flex flex-nowrap overflow-x-auto -mx-4 px-4 gap-x-1 -mb-px sm:mx-0 sm:px-0 sm:flex-wrap sm:overflow-visible">
        {tabs.map((tab) => {
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

      {/*
        Plain anchors to a route handler, not a client toggle: the cookie is
        httpOnly and every string on the page is rendered on the server, so the
        whole tree has to come back. Same shape as the organisation switch.
      */}
      <ul className="mb-1.5 flex shrink-0 items-center gap-1" aria-label={t.language}>
        {FACTORY_LOCALES.map((code) => (
          <li key={code}>
            <a
              href={`/factory-lang/${code}?next=${encodeURIComponent(pathname)}`}
              aria-current={code === locale ? 'true' : undefined}
              title={FACTORY_LOCALE_NAMES[code]}
              className={
                code === locale
                  ? 'rounded px-2 py-1 text-xs font-semibold uppercase tracking-wider text-gray-900'
                  : 'rounded px-2 py-1 text-xs font-medium uppercase tracking-wider text-gray-400 hover:bg-gray-100 hover:text-gray-700'
              }
            >
              {code}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  )
}
