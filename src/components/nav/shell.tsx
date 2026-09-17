'use client'

// page-state: none (the mobile drawer, which is chrome and closes itself on navigation)

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Menu, X } from 'lucide-react'
import { Sidebar } from '@/components/nav/sidebar'
import { OpenOnPhone } from '@/components/nav/open-on-phone'
import { Avatar } from '@/components/profile/avatar'
import { isStaging } from '@/lib/env'
import type { CapabilityKey } from '@/lib/capabilities'
import type { OrgCode } from '@/lib/organisations'
import { OrganisationSwitcher } from '@/components/nav/organisation-switcher'

/** Who is signed in, as the header and sidebar show them. Every field but the
 *  id can be null: no email, no name set, no job title, or no photo. */
export interface ShellProfile {
  id: string
  email: string | null
  displayName: string | null
  jobTitle: string | null
  /** From avatarSrc(); null shows initials instead of a photo. */
  avatarSrc: string | null
}

interface ShellProps {
  capabilities: CapabilityKey[]
  /** An outside company's account: no home row, and nothing else to switch. */
  isExternal: boolean
  /** Nav labels in the viewer's own language, keyed by href. */
  navLabels?: Record<string, string>
  signOutLabel?: string
  /** The organisations this person holds, and the one they are looking at. */
  organisations: OrgCode[]
  activeOrg: OrgCode | null
  displayName: string
  profile: ShellProfile
  children: React.ReactNode
}

/**
 * Responsive app shell. Below lg the sidebar becomes an off-canvas drawer
 * behind a hamburger in the header; from lg up it is the same fixed 256px
 * rail the app has always had. Client component so it can own the drawer
 * state; `children` arrives as a prop from the server layout, so pages stay
 * server-rendered.
 */
export function Shell({ capabilities, isExternal, navLabels, signOutLabel, organisations, activeOrg, displayName, profile, children }: ShellProps) {
  const [open, setOpen] = useState(false)
  const pathname = usePathname()

  // Navigating (tapping a nav link, or any redirect) closes the drawer.
  // State is adjusted during render rather than in an effect: the React
  // Compiler flags a synchronous setState-in-effect, and this is the
  // documented "storing information from previous renders" pattern.
  const [prevPathname, setPrevPathname] = useState(pathname)
  if (prevPathname !== pathname) {
    setPrevPathname(pathname)
    if (open) setOpen(false)
  }

  // While the drawer is open the page behind it must not scroll, and Escape
  // should close it, same as any overlay.
  useEffect(() => {
    if (!open) return
    const { overflow } = document.body.style
    document.body.style.overflow = 'hidden'
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => {
      document.body.style.overflow = overflow
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div className="flex min-h-screen bg-gray-100">
      {/* Scrim behind the mobile drawer */}
      {open && (
        <button
          type="button"
          aria-label="Close menu"
          onClick={() => setOpen(false)}
          className="fixed inset-0 z-20 bg-black/50 lg:hidden"
        />
      )}

      <Sidebar
        capabilities={capabilities}
        isExternal={isExternal}
        navLabels={navLabels}
        signOutLabel={signOutLabel}
        organisations={organisations}
        activeOrg={activeOrg}
        displayName={displayName}
        profile={profile}
        className={`transition-transform duration-200 ease-out lg:translate-x-0 ${
          open ? 'translate-x-0' : '-translate-x-full'
        }`}
      />

      {/* min-w-0 lets this flex item shrink below its content's intrinsic width so a
          wide board (kanban/table) scrolls INSIDE the content area instead of growing
          `main` past the viewport and sliding over the fixed sidebar. */}
      <main className="flex-1 lg:ml-64 flex flex-col min-h-screen min-w-0">
        {/* Carried over from the layout this Shell replaced: the sandbox banner has to
            sit above the sticky header, not inside it, or it scrolls away. */}
        {isStaging() && (
          <div className="bg-amber-400 text-amber-950 text-center text-xs font-semibold px-4 py-1.5 border-b border-amber-500">
            STAGING SANDBOX &middot; test data only, not connected to live Xero, HubSpot or Cargo Partner
          </div>
        )}
        <header className="bg-white border-b border-gray-200 px-4 sm:px-6 lg:px-8 py-3 lg:py-4 flex items-center justify-between sticky top-0 z-10">
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => setOpen((v) => !v)}
              aria-label={open ? 'Close menu' : 'Open menu'}
              aria-expanded={open}
              className="lg:hidden -ml-2 flex h-11 w-11 items-center justify-center rounded text-gray-700 hover:bg-gray-100 focus:outline-none focus:ring-2 focus:ring-echo-orange/50"
            >
              {open ? <X className="h-6 w-6" /> : <Menu className="h-6 w-6" />}
            </button>
            <h2 className="text-base lg:text-lg font-bold text-gray-800 uppercase tracking-wide">
              Echo Barrier Hub
            </h2>
            {/* Which organisation everything on this page belongs to. One for
                the whole Hub, so it is said once, here, on every screen size.
                Since 16 Sep 2026 it is also where you change it. */}
            {activeOrg && (
              <OrganisationSwitcher organisations={organisations} activeOrg={activeOrg} pathname={pathname} />
            )}
          </div>
          {/* Both controls keep a 44px tap target on mobile (the hamburger's size).
              On lg the negative margin keeps their 40px boxes from making the
              header taller than the 32px circle that used to sit here. */}
          <div className="flex items-center gap-1 lg:gap-2">
            <OpenOnPhone className="lg:-my-1" />
            <Link
              href="/profile"
              aria-label="Your profile"
              title={profile.displayName?.trim() || profile.email || 'Your profile'}
              className="flex h-11 w-11 lg:h-10 lg:w-10 lg:-my-1 items-center justify-center rounded-full hover:bg-gray-100 focus:outline-none focus:ring-2 focus:ring-echo-orange/50"
            >
              <Avatar src={profile.avatarSrc} name={profile.displayName} email={profile.email} size="sm" />
            </Link>
          </div>
        </header>

        <div className="p-4 sm:p-6 lg:p-8 flex-1 overflow-auto min-w-0">{children}</div>
      </main>
    </div>
  )
}
