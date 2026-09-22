'use client'
// page-state: view (the tab and the search box, remembered per user)

import { useState, useTransition } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { RefreshCw, Search, Ship, AlertTriangle, PackageCheck } from 'lucide-react'
import { toast } from 'sonner'
import { usePersistedView } from '@/hooks/use-page-state'
import { depotLabel } from '@/lib/depot-constants'
import { syncCargo } from '@/app/actions/cargo/sync-cargo'
import type { CargoBoardRow } from '@/lib/cargo/store'

/**
 * Containers, as a list you can act on.
 *
 * In transit first and by arrival date, because the question this screen answers
 * is "what is coming and when". A slipped schedule is called out in words rather
 * than left for somebody to work out from two dates.
 */

type Tab = 'transit' | 'arrived' | 'all'

/** What is remembered between visits: which tab, and what was typed. */
interface CargoView {
  v: 1
  tab: Tab
  q: string
}

const DEFAULT_VIEW: CargoView = { v: 1, tab: 'transit', q: '' }

function parseCargoView(raw: unknown): CargoView | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const tab = r.tab
  if (tab !== 'transit' && tab !== 'arrived' && tab !== 'all') return null
  return { v: 1, tab, q: typeof r.q === 'string' ? r.q.slice(0, 200) : '' }
}

const TABS: { key: Tab; label: string }[] = [
  { key: 'transit', label: 'In transit' },
  { key: 'arrived', label: 'Arrived' },
  { key: 'all', label: 'All' },
]

function shortDate(iso: string | null): string {
  if (!iso) return '—'
  const [y, m, d] = iso.split('-')
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  return `${Number(d)} ${months[Number(m) - 1] ?? m} ${y.slice(2)}`
}

function daysUntil(iso: string | null, today: string): number | null {
  if (!iso) return null
  const a = Date.parse(`${today}T00:00:00Z`)
  const b = Date.parse(`${iso}T00:00:00Z`)
  return Number.isFinite(a) && Number.isFinite(b) ? Math.round((b - a) / 86_400_000) : null
}

export default function CargoBoard({ rows, today }: { rows: CargoBoardRow[]; today: string }) {
  // The tab and the search box come back; nothing else does. Which container
  // somebody had open is deliberately forgotten: a container arrives while you
  // are away, and reopening a card onto a shipment that has moved on is worse
  // than opening none.
  const [view, setView] = usePersistedView<CargoView>('cargo-board', DEFAULT_VIEW, parseCargoView)
  const { tab, q: query } = view
  const setTab = (next: Tab) => setView({ ...view, tab: next })
  const setQuery = (next: string) => setView({ ...view, q: next })
  const [syncing, startSync] = useTransition()
  const [lastSync, setLastSync] = useState<string | null>(null)
  const router = useRouter()

  const needle = query.trim().toLowerCase()
  const shown = rows
    .filter((r) => (tab === 'transit' ? !r.isComplete : tab === 'arrived' ? r.isComplete : true))
    .filter((r) =>
      !needle
        ? true
        : [
            r.spotId,
            r.generalReference,
            r.vesselName,
            r.oceanCarrier,
            r.destinationCity,
            r.destinationDepot,
            r.cargoDescription,
            ...r.containerNumbers,
          ]
            .filter(Boolean)
            .some((v) => String(v).toLowerCase().includes(needle)),
    )

  function refresh() {
    startSync(async () => {
      const res = await syncCargo()
      if (!res.ok) {
        toast.error(res.error)
        return
      }
      const { synced, attempted, failed } = res.result
      setLastSync(new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }))
      if (failed.length) {
        toast.warning(`${synced} of ${attempted} shipments refreshed. ${failed.length} could not be read.`)
      } else {
        toast.success(`${synced} shipments refreshed from Cargo Partner.`)
      }
      router.refresh()
    })
  }

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="flex flex-nowrap gap-1 overflow-x-auto rounded-lg border border-gray-200 bg-white p-1">
          {TABS.map(({ key, label }) => {
            const count = rows.filter((r) =>
              key === 'transit' ? !r.isComplete : key === 'arrived' ? r.isComplete : true,
            ).length
            return (
              <button
                key={key}
                onClick={() => setTab(key)}
                className={`shrink-0 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                  tab === key ? 'bg-[#025945] text-white' : 'text-gray-600 hover:bg-gray-50'
                }`}
              >
                {label} <span className="tabular-nums opacity-70">{count}</span>
              </button>
            )
          })}
        </div>

        <div className="relative min-w-52 flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Container, vessel, order number, depot"
            className="w-full rounded-lg border border-gray-300 bg-white py-2 pl-9 pr-3 text-sm placeholder:text-gray-400 focus:border-[#025945] focus:outline-none"
          />
        </div>

        <button
          onClick={refresh}
          disabled={syncing}
          className="inline-flex shrink-0 items-center gap-2 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 disabled:opacity-60"
        >
          <RefreshCw className={`h-4 w-4 ${syncing ? 'animate-spin' : ''}`} />
          {syncing ? 'Refreshing' : 'Refresh from Cargo Partner'}
        </button>
        {lastSync && <span className="text-xs text-gray-400">Refreshed {lastSync}</span>}
      </div>

      {shown.length === 0 ? (
        <div className="rounded-xl border border-gray-200 bg-white p-10 text-center">
          <Ship className="mx-auto mb-3 h-8 w-8 text-gray-300" />
          <p className="text-sm text-gray-500">
            {rows.length === 0
              ? 'No shipments yet. Refresh from Cargo Partner to pull them in.'
              : 'Nothing here matches what you are looking for.'}
          </p>
        </div>
      ) : (
        <ul className="space-y-2">
          {shown.map((r) => {
            const due = daysUntil(r.eta, today)
            const late = r.slipDays != null && r.slipDays >= 1
            return (
              <li key={r.spotId}>
                <Link
                  href={`/transport/${r.spotId}`}
                  className="block rounded-xl border border-gray-200 bg-white p-4 transition-colors hover:border-gray-300 hover:bg-gray-50"
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="flex flex-wrap items-center gap-2 text-sm font-semibold text-gray-900">
                        {r.containerNumbers.length ? r.containerNumbers.join(', ') : `SPOT ${r.spotId}`}
                        {r.isComplete ? (
                          <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700">
                            <PackageCheck className="h-3 w-3" /> Arrived
                          </span>
                        ) : (
                          late && (
                            <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-700">
                              <AlertTriangle className="h-3 w-3" /> {r.slipDays} days later than first planned
                            </span>
                          )
                        )}
                      </p>
                      <p className="mt-0.5 truncate text-sm text-gray-600">
                        {r.originCity ?? '—'} to {r.destinationCity ?? '—'}
                        {r.destinationDepot ? ` (${depotLabel(r.destinationDepot)})` : ''}
                      </p>
                      <p className="mt-1 text-xs text-gray-500">
                        {[r.cargoDescription, r.totalPieces ? `${r.totalPieces} pieces` : null, r.vesselName, r.generalReference]
                          .filter(Boolean)
                          .join(' · ')}
                      </p>
                    </div>

                    <div className="text-right">
                      <p className="text-xs text-gray-500">{r.isComplete ? 'Arrived' : 'Expected'}</p>
                      <p className="text-sm font-semibold tabular-nums text-gray-900">{shortDate(r.eta)}</p>
                      {!r.isComplete && due != null && (
                        <p className={`text-xs tabular-nums ${due < 0 ? 'text-amber-700' : 'text-gray-500'}`}>
                          {due < 0 ? `${Math.abs(due)} days overdue` : due === 0 ? 'today' : `in ${due} days`}
                        </p>
                      )}
                    </div>
                  </div>

                  {r.currentStatus && (
                    <p className="mt-3 border-t border-gray-100 pt-2 text-xs text-gray-600">
                      <span className="font-medium text-gray-900">{r.currentStatus}</span>
                      {r.currentStatusLocation ? ` at ${r.currentStatusLocation}` : ''}
                      {r.currentStatusOn ? ` on ${shortDate(r.currentStatusOn)}` : ''}
                    </p>
                  )}
                </Link>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
