'use client'

// page-state: none (whether the menu is open. It closes on choice, Escape or a
// click elsewhere, and the choice itself is a cookie the server sets.)

import { useEffect, useId, useRef, useState } from 'react'
import { Check, ChevronDown } from 'lucide-react'
import { FlagIcon } from '@/components/ui/flag-icon'
import { organisation, type OrgCode } from '@/lib/organisations'
import { nextPathAfterSwitch } from '@/lib/active-organisation'

/**
 * The organisation badge in the header, and the switch behind it.
 *
 * Dean, 16 Sep 2026: "you should be able to click on the flag at the top next
 * to Echo Barrier Hub to change the current loaded country."
 *
 * With one organisation there is nothing to choose between, so it stays the
 * plain badge it was. With more it becomes a button that opens the list; each
 * entry is an ordinary link to the /org/<code> route the sidebar already uses,
 * so switching is one full navigation and the whole tree re-renders under the
 * new organisation, exactly as it does from the sidebar. Nothing is decided
 * here: the route checks the person holds the organisation before it sets
 * anything.
 *
 * The test id stays on whichever element shows the label, so the checks that
 * read the badge's text keep reading it.
 */
export function OrganisationSwitcher({
  organisations,
  activeOrg,
  pathname,
}: {
  organisations: OrgCode[]
  activeOrg: OrgCode
  pathname: string
}) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const menuId = useId()
  const active = organisation(activeOrg)

  // Close on a click anywhere else, and on Escape.
  useEffect(() => {
    if (!open) return
    const onPointer = (e: MouseEvent | TouchEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onPointer)
    document.addEventListener('touchstart', onPointer)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onPointer)
      document.removeEventListener('touchstart', onPointer)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const badge = 'inline-flex items-center gap-1.5 rounded-full border border-gray-300 bg-gray-50 px-2.5 py-0.5 text-xs font-semibold text-gray-800'

  if (organisations.length < 2) {
    return (
      <span data-testid="active-organisation" className={badge}>
        <FlagIcon code={active.flag} />
        {active.label}
      </span>
    )
  }

  return (
    <div ref={root} className="relative">
      <button
        type="button"
        data-testid="active-organisation"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        aria-label={`Switch organisation, currently ${active.label}`}
        title="Switch organisation"
        className={`${badge} hover:bg-gray-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-echo-orange/50`}
      >
        <FlagIcon code={active.flag} />
        {active.label}
        <ChevronDown className={`h-3 w-3 text-gray-500 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <ul
          id={menuId}
          role="menu"
          aria-label="Organisations"
          className="absolute left-0 top-full z-20 mt-1.5 min-w-44 overflow-hidden rounded-lg border border-gray-200 bg-white py-1 shadow-lg"
        >
          {organisations.map((code) => {
            const org = organisation(code)
            const current = code === activeOrg
            const next = nextPathAfterSwitch(pathname, code)
            return (
              <li key={code} role="none">
                <a
                  role="menuitem"
                  href={`/org/${encodeURIComponent(code)}?next=${encodeURIComponent(next)}`}
                  aria-current={current ? 'true' : undefined}
                  className={`flex items-center gap-2.5 px-3 py-2 text-sm ${
                    current ? 'bg-gray-100 font-semibold text-gray-900' : 'text-gray-700 hover:bg-gray-50'
                  }`}
                >
                  <FlagIcon code={org.flag} />
                  <span className="flex-1">{org.label}</span>
                  {current && <Check className="h-3.5 w-3.5 text-gray-500" />}
                </a>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
