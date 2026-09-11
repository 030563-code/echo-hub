'use client'

// page-state: view stock-board:materials (search box)

import { useState } from 'react'
import { Layers } from 'lucide-react'
import { EmptyState } from '@/components/ui/empty-state'
import { SearchBox } from '@/components/ui/search-box'
import StatusBadge from '@/components/board/StatusBadge'
import { usePersistedView } from '@/hooks/use-page-state'
import { parseSearchView, type SearchView } from '@/lib/page-drafts'
import { SRO_WAREHOUSE, STALE_COUNT_DAYS } from '@/lib/stock/warehouses'
import type { MaterialPosition } from '@/lib/stock/board-data'
import { MovementsPanel } from '../movements-panel'
import { RecordCountDialog } from '../record-count-dialog'
import { AdjustStockDialog } from '../adjust-stock-dialog'

function countBadge(iso: string | null): string {
  if (!iso) return 'never_counted'
  const age = (Date.now() - Date.parse(iso)) / 86_400_000
  return age > STALE_COUNT_DAYS ? 'count_stale' : 'counted'
}

const fmt = (n: number | null) => (n === null ? '—' : Number.isInteger(n) ? String(n) : n.toFixed(3).replace(/\.?0+$/, ''))

export default function MaterialsBoard({ rows, canEdit }: { rows: MaterialPosition[]; canEdit: boolean }) {
  const [view, setView] = usePersistedView<SearchView>('stock-board:materials', { v: 1, q: '' }, parseSearchView)
  const [selected, setSelected] = useState<MaterialPosition | null>(null)

  const needle = view.q.trim().toLowerCase()
  const filtered = needle
    ? rows.filter((r) => `${r.component_code} ${r.description ?? ''}`.toLowerCase().includes(needle))
    : rows

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm text-gray-600">
          Raw materials Echo Barrier s.r.o. owns and supplies to Bamida, at {SRO_WAREHOUSE}. Bamida&apos;s own
          materials come from their daily feed and are shown beside each code where the two overlap.
        </p>
        <div className="flex items-center gap-2">
          <SearchBox value={view.q} onChange={(q) => setView({ v: 1, q })} placeholder="Search component…" />
          {canEdit && (
            <>
              <RecordCountDialog itemKind="material" defaultWarehouse={SRO_WAREHOUSE} />
              <AdjustStockDialog itemKind="material" defaultWarehouse={SRO_WAREHOUSE} />
            </>
          )}
        </div>
      </div>

      {filtered.length === 0 ? (
        <EmptyState
          icon={<Layers className="w-7 h-7" />}
          title={needle ? 'No matching component' : 'No materials counted yet'}
          description={needle ? `Nothing matches “${view.q}”.` : 'Record a count of the s.r.o.-owned materials to start.'}
        />
      ) : (
        <div className="overflow-auto rounded-lg border border-gray-200 bg-white">
          <table className="w-full min-w-[820px] text-sm">
            <thead>
              <tr className="border-b border-gray-200 bg-gray-50">
                {['Component', 'Description', 'Unit', 'On hand (s.r.o.)', 'Est. used since count', 'At Bamida', 'Last counted'].map((h) => (
                  <th key={h} className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider whitespace-nowrap">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map((r) => (
                <tr key={r.component_code} className="border-b border-gray-100 last:border-0 hover:bg-gray-50 cursor-pointer" onClick={() => setSelected(r)}>
                  <td className="px-4 py-3"><span className="font-mono text-xs text-echo-orange">{r.component_code}</span></td>
                  <td className="px-4 py-3 text-gray-600">{r.description ?? '—'}</td>
                  <td className="px-4 py-3 text-gray-500">{r.unit ?? '—'}</td>
                  <td className={`px-4 py-3 font-semibold tabular-nums ${r.on_hand < 0 ? 'text-red-700' : 'text-gray-900'}`}>{fmt(r.on_hand)}</td>
                  <td className="px-4 py-3 tabular-nums text-amber-700">{r.estimated_since_count === 0 ? <span className="text-gray-400">0</span> : fmt(r.estimated_since_count)}</td>
                  <td className="px-4 py-3 tabular-nums text-gray-600">
                    {r.bamida_quantity === null ? (
                      <span className="text-gray-400">no Bamida card</span>
                    ) : (
                      <>
                        {fmt(r.bamida_quantity)} {r.bamida_unit ?? ''}
                        {r.bamida_synced_at && (
                          <span className="block text-xs text-gray-400">
                            synced {new Date(r.bamida_synced_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}
                          </span>
                        )}
                      </>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <StatusBadge status={countBadge(r.last_counted_at)} />
                      {r.last_counted_at && (
                        <span className="text-xs text-gray-500">
                          {new Date(r.last_counted_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}
                        </span>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {selected && (
        <MovementsPanel
          key={selected.component_code}
          itemKind="material"
          warehouse={SRO_WAREHOUSE}
          sku={selected.component_code}
          title={`${selected.component_code} at ${SRO_WAREHOUSE}`}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  )
}
