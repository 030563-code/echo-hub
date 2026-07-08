'use client'

import Link, { useLinkStatus } from 'next/link'
import Image from 'next/image'
import { usePathname } from 'next/navigation'
import { useState } from 'react'
import {
  LayoutDashboard,
  FileText,
  ShoppingCart,
  Layers,
  Truck,
  Gauge,
  Receipt,
  LogOut,
  Loader2,
  Menu,
  X,
  type LucideIcon,
} from 'lucide-react'
import { NAV_ITEMS, satisfiesRequirement, type CapabilityKey } from '@/lib/capabilities'
import { Button } from '@/components/ui/button'
import { signOut } from '@/app/actions/sign-out'

const ICONS: Record<string, LucideIcon> = {
  LayoutDashboard,
  FileText,
  ShoppingCart,
  Layers,
  Truck,
  Gauge,
  Receipt,
}

interface SidebarProps {
  capabilities: CapabilityKey[]
  displayName: string
}

// Inner content of a nav link. useLinkStatus() must run inside a <Link>, and gives
// THIS link's navigation-pending state — so the clicked tab swaps its icon for a
// spinner immediately, before the destination page has rendered.
function NavItemContent({ Icon, label }: { Icon: LucideIcon; label: string }) {
  const { pending } = useLinkStatus()
  return (
    <>
      {pending ? <Loader2 className="w-5 h-5 animate-spin text-[#FF7026]" /> : <Icon className="w-5 h-5" />}
      <span className="font-medium">{label}</span>
    </>
  )
}

export function Sidebar({ capabilities, displayName }: SidebarProps) {
  const pathname = usePathname()
  const [open, setOpen] = useState(false)
  const caps = new Set<CapabilityKey>(capabilities)

  const visible = NAV_ITEMS.filter((item) => satisfiesRequirement(caps, item.requires))

  return (
    <>
      {/* Mobile hamburger — opens the drawer (hidden on md+ where the sidebar is fixed). */}
      <button
        onClick={() => setOpen(true)}
        aria-label="Open menu"
        className="md:hidden fixed top-3 left-3 z-50 p-2 rounded-lg bg-black text-white shadow-lg"
      >
        <Menu className="w-5 h-5" />
      </button>

      {/* Backdrop when the mobile drawer is open. */}
      {open && <div className="md:hidden fixed inset-0 bg-black/50 z-40" onClick={() => setOpen(false)} aria-hidden="true" />}

      <aside
        className={`w-64 bg-black text-white flex flex-col fixed h-full z-40 transition-transform duration-200 ${
          open ? 'translate-x-0' : '-translate-x-full'
        } md:translate-x-0`}
      >
        <div className="p-5 border-b border-gray-800 flex items-start justify-between">
          <div>
            <Link href="/">
              <Image src="/logo.jpg" alt="Echo Barrier" width={160} height={48} className="object-contain invert" priority />
            </Link>
            <p className="text-xs text-gray-500 uppercase tracking-wider mt-2">Hub</p>
          </div>
          <button onClick={() => setOpen(false)} aria-label="Close menu" className="md:hidden text-gray-500 hover:text-white -mt-1">
            <X className="w-5 h-5" />
          </button>
        </div>

        <nav className="flex-1 p-4 space-y-1 overflow-y-auto">
          {visible.map((item) => {
            const Icon = ICONS[item.icon] ?? LayoutDashboard
            const active =
              item.href === '/' ? pathname === '/' : pathname === item.href || pathname.startsWith(`${item.href}/`)
            return (
              <Link
                key={item.href}
                href={item.href}
                onClick={() => setOpen(false)}
                className={`relative flex items-center gap-3 px-4 py-3 rounded transition-colors ${
                  active ? 'bg-gray-900 text-white' : 'text-gray-400 hover:bg-gray-900 hover:text-white'
                }`}
              >
                {active && (
                  <span className="absolute left-0 top-1/2 -translate-y-1/2 h-6 w-1 rounded-r bg-[#FF7026]" aria-hidden="true" />
                )}
                <NavItemContent Icon={Icon} label={item.label} />
              </Link>
            )
          })}
        </nav>

        <div className="p-4 border-t border-gray-800 bg-gray-900/50">
          <div className="mb-4 px-2">
            <p className="text-xs text-gray-500 uppercase font-bold mb-1">Logged in as</p>
            <p className="text-sm font-medium truncate text-white" title={displayName}>
              {displayName}
            </p>
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
    </>
  )
}
