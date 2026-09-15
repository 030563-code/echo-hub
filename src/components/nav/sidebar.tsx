'use client'

// page-state: none (which organisation list is open is chrome; a fresh load derives it from the route again)

import { useState } from 'react'
import Link from 'next/link'
import Image from 'next/image'
import { usePathname } from 'next/navigation'
import { ChevronDown, LogOut } from 'lucide-react'
import { navSections, type CapabilityKey, type NavItem } from '@/lib/capabilities'
import { NAV_ICONS } from '@/lib/nav-icons'
import { organisation, orgsForNavItem, type OrgCode } from '@/lib/organisations'
import { FlagIcon } from '@/components/ui/flag-icon'
import { Button } from '@/components/ui/button'
import { signOut } from '@/app/actions/sign-out'
import { LinkSpinner } from '@/components/nav/link-spinner'
import { Avatar } from '@/components/profile/avatar'
import type { ShellProfile } from '@/components/nav/shell'

interface SidebarProps {
  capabilities: CapabilityKey[]
  /** The organisations this person holds, in registry order. */
  organisations: OrgCode[]
  /** The one they are looking at, or null when they hold none. */
  activeOrg: OrgCode | null
  displayName: string
  profile: ShellProfile
  /** Positioning/visibility classes from the shell (off-canvas transform on mobile). */
  className?: string
}

function isWithin(pathname: string, item: NavItem): boolean {
  return item.href === '/' ? pathname === '/' : pathname === item.href || pathname.startsWith(`${item.href}/`)
}

/**
 * The rail: one row per module the person may open, and under a scoped module
 * the organisations they hold for it (Dean, 15 Sep 2026: "a dropdown under
 * each section ... the other users will only be able to see their own").
 *
 * The organisation rows are plain links to /org/[code], which sets the
 * hub_org cookie and sends the browser back to the module with a full load.
 * Not <Link>: the header badge and every sub-list live in the layout, and the
 * whole tree has to re-render with the new organisation.
 */
export function Sidebar({ capabilities, organisations, activeOrg, displayName, profile, className = '' }: SidebarProps) {
  const pathname = usePathname()
  const caps = new Set<CapabilityKey>(capabilities)
  const sections = navSections(caps)

  // A module's list opens with the module (you are in Quotes, so here are the
  // organisations for Quotes) and its chevron opens or closes it without
  // leaving the page. Nothing here is worth keeping across loads.
  const [toggled, setToggled] = useState<Record<string, boolean>>({})

  return (
    <aside className={`w-64 bg-black text-white flex flex-col fixed h-full z-30 ${className}`}>
      <div className="p-5 border-b border-gray-800">
        <Link
          href="/"
          aria-label="Echo Barrier Hub, home"
          className="flex flex-col items-center text-center rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-echo-orange/50"
        >
          <Image
            src="/logo.jpg"
            alt=""
            width={160}
            height={48}
            className="object-contain invert"
            priority
          />
          {/* Letter-spacing also trails the last letter, so the matching left
              padding is what centres the word optically under the logo. */}
          <span className="mt-2 pl-[0.3em] text-sm font-semibold uppercase tracking-[0.3em] text-gray-300">
            Hub
          </span>
        </Link>
      </div>

      <nav className="flex-1 p-4 overflow-y-auto">
        {sections.map((section) => (
          <div key={section.group ?? 'top'} className="space-y-1 [&+&]:mt-6">
            {section.group && (
              <h2 className="px-4 pb-1 text-[11px] font-bold uppercase tracking-wider text-gray-500">
                {section.group}
              </h2>
            )}
            {section.items.map((item) => {
              const Icon = NAV_ICONS[item.icon]
              const active = isWithin(pathname, item)
              // One organisation is nothing to choose between, so the list
              // only appears for two or more; the header badge says which one.
              const orgs = orgsForNavItem(item.module, organisations)
              const hasList = orgs.length > 1
              const expanded = hasList && (toggled[item.href] ?? active)
              return (
                <div key={item.href}>
                  <div
                    className={`flex items-center rounded transition-colors ${
                      active ? 'bg-gray-900 text-white' : 'text-gray-400 hover:bg-gray-900 hover:text-white'
                    }`}
                  >
                    <Link href={item.href} className="flex min-w-0 flex-1 items-center gap-3 px-4 py-3">
                      <Icon className="w-5 h-5 shrink-0" />
                      <span className="font-medium truncate">{item.label}</span>
                      {/* useLinkStatus must be a child of Link, hence the separate LinkSpinner component */}
                      <LinkSpinner className="ml-auto" />
                    </Link>
                    {hasList && (
                      <button
                        type="button"
                        onClick={() => setToggled({ ...toggled, [item.href]: !expanded })}
                        aria-expanded={expanded}
                        aria-label={`Organisations for ${item.label}`}
                        className="flex h-11 w-10 shrink-0 items-center justify-center rounded text-gray-500 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-echo-orange/50"
                      >
                        <ChevronDown className={`h-4 w-4 transition-transform ${expanded ? 'rotate-180' : ''}`} />
                      </button>
                    )}
                  </div>
                  {expanded && (
                    <ul className="mt-1 mb-2 ml-6 space-y-0.5 border-l border-gray-800 pl-3">
                      {orgs.map((code) => {
                        const org = organisation(code)
                        const current = code === activeOrg
                        return (
                          <li key={code}>
                            <a
                              href={`/org/${encodeURIComponent(code)}?next=${encodeURIComponent(item.href)}`}
                              aria-current={current ? 'true' : undefined}
                              className={`flex items-center gap-2.5 rounded px-3 py-2 text-sm ${
                                current ? 'bg-gray-900 font-semibold text-white' : 'text-gray-400 hover:bg-gray-900 hover:text-white'
                              }`}
                            >
                              <FlagIcon code={org.flag} />
                              <span>{org.label}</span>
                            </a>
                          </li>
                        )
                      })}
                    </ul>
                  )}
                </div>
              )
            })}
          </div>
        ))}
      </nav>

      <div className="p-4 border-t border-gray-800 bg-gray-900/50">
        <div className="mb-4">
          <p className="px-2 text-xs text-gray-500 uppercase font-bold mb-1">Logged in as</p>
          <Link
            href="/profile"
            className="group flex items-center gap-3 rounded px-2 py-2 hover:bg-gray-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-echo-orange/50"
          >
            <Avatar src={profile.avatarSrc} name={profile.displayName} email={profile.email} size="sm" />
            {/* min-w-0 lets the text column shrink so a long email or title
                truncates inside the 256px rail instead of widening it. */}
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium truncate text-white" title={displayName}>
                {displayName}
              </span>
              {profile.jobTitle && (
                <span className="block text-xs text-gray-400 truncate" title={profile.jobTitle}>
                  {profile.jobTitle}
                </span>
              )}
              <span className="block text-xs font-medium text-echo-orange group-hover:underline">Edit profile</span>
            </span>
          </Link>
        </div>
        <form action={signOut}>
          <Button
            variant="ghost"
            className="w-full justify-start text-red-500 hover:text-red-400 hover:bg-red-900/20 flex items-center"
          >
            <LogOut className="w-4 h-4 mr-2" />
            Sign Out
          </Button>
        </form>
      </div>
    </aside>
  )
}
