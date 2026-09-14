'use client'

import Link from 'next/link'
import Image from 'next/image'
import { usePathname } from 'next/navigation'
import { LogOut } from 'lucide-react'
import { navSections, type CapabilityKey } from '@/lib/capabilities'
import { NAV_ICONS } from '@/lib/nav-icons'
import { Button } from '@/components/ui/button'
import { signOut } from '@/app/actions/sign-out'
import { LinkSpinner } from '@/components/nav/link-spinner'
import { Avatar } from '@/components/profile/avatar'
import type { ShellProfile } from '@/components/nav/shell'

interface SidebarProps {
  capabilities: CapabilityKey[]
  displayName: string
  profile: ShellProfile
  /** Positioning/visibility classes from the shell (off-canvas transform on mobile). */
  className?: string
}

export function Sidebar({ capabilities, displayName, profile, className = '' }: SidebarProps) {
  const pathname = usePathname()
  const caps = new Set<CapabilityKey>(capabilities)

  const sections = navSections(caps)

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
              const active =
                item.href === '/' ? pathname === '/' : pathname === item.href || pathname.startsWith(`${item.href}/`)
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={`flex items-center gap-3 px-4 py-3 rounded transition-colors ${
                    active
                      ? 'bg-gray-900 text-white'
                      : 'text-gray-400 hover:bg-gray-900 hover:text-white'
                  }`}
                >
                  <Icon className="w-5 h-5" />
                  <span className="font-medium">{item.label}</span>
                  {/* useLinkStatus must be a child of Link, hence the separate LinkSpinner component */}
                  <LinkSpinner className="ml-auto" />
                </Link>
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
