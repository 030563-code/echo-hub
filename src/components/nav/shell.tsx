'use client'

import { useEffect, useState } from 'react'
import { usePathname } from 'next/navigation'
import { Menu, X } from 'lucide-react'
import { Sidebar } from '@/components/nav/sidebar'
import type { CapabilityKey } from '@/lib/capabilities'

interface ShellProps {
  capabilities: CapabilityKey[]
  displayName: string
  children: React.ReactNode
}

/**
 * Responsive app shell. Below lg the sidebar becomes an off-canvas drawer
 * behind a hamburger in the header; from lg up it is the same fixed 256px
 * rail the app has always had. Client component so it can own the drawer
 * state; `children` arrives as a prop from the server layout, so pages stay
 * server-rendered.
 */
export function Shell({ capabilities, displayName, children }: ShellProps) {
  const [open, setOpen] = useState(false)
  const pathname = usePathname()

  // Navigating (tapping a nav link, or any redirect) closes the drawer.
  useEffect(() => {
    setOpen(false)
  }, [pathname])

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
        displayName={displayName}
        className={`transition-transform duration-200 ease-out lg:translate-x-0 ${
          open ? 'translate-x-0' : '-translate-x-full'
        }`}
      />

      {/* min-w-0 lets this flex item shrink below its content's intrinsic width so a
          wide board (kanban/table) scrolls INSIDE the content area instead of growing
          `main` past the viewport and sliding over the fixed sidebar. */}
      <main className="flex-1 lg:ml-64 flex flex-col min-h-screen min-w-0">
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
          </div>
          <div className="flex items-center gap-4">
            <div className="h-8 w-8 rounded-full bg-gray-200 border border-gray-300" />
          </div>
        </header>

        <div className="p-4 sm:p-6 lg:p-8 flex-1 overflow-auto min-w-0">{children}</div>
      </main>
    </div>
  )
}
