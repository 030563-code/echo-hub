'use client'

import Link from 'next/link'
import Image from 'next/image'
import { usePathname } from 'next/navigation'
import {
  LayoutDashboard,
  FileText,
  ShoppingCart,
  Layers,
  Truck,
  Gauge,
  LogOut,
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
}

interface SidebarProps {
  capabilities: CapabilityKey[]
  displayName: string
}

export function Sidebar({ capabilities, displayName }: SidebarProps) {
  const pathname = usePathname()
  const caps = new Set<CapabilityKey>(capabilities)

  const visible = NAV_ITEMS.filter((item) => satisfiesRequirement(caps, item.requires))

  return (
    <aside className="w-64 bg-black text-white flex flex-col fixed h-full">
      <div className="p-5 border-b border-gray-800">
        <Link href="/">
          <Image
            src="/logo.jpg"
            alt="Echo Barrier"
            width={160}
            height={48}
            className="object-contain invert"
            priority
          />
        </Link>
        <p className="text-xs text-gray-500 uppercase tracking-wider mt-2">Hub</p>
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
              className={`flex items-center gap-3 px-4 py-3 rounded transition-colors ${
                active
                  ? 'bg-gray-900 text-white'
                  : 'text-gray-400 hover:bg-gray-900 hover:text-white'
              }`}
            >
              <Icon className="w-5 h-5" />
              <span className="font-medium">{item.label}</span>
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
  )
}
