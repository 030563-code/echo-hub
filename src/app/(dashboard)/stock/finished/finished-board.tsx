'use client'

// page-state: view stock-board (search box and the warehouse in view)

import { useState } from 'react'
import { Boxes } from 'lucide-react'
import { EmptyState } from '@/components/ui/empty-state'
import { SearchBox } from '@/components/ui/search-box'
import StatusBadge from '@/components/board/StatusBadge'
import { usePersistedView } from '@/hooks/use-page-state'
import { parseStockBoardView, type StockBoardView } from '@/lib/page-drafts'
import { entityLabel } from '@/lib/depot-constants'
import { STOCK_WAREHOUSES, SRO_WAREHOUSE } from '@/lib/stock/warehouses'
import type { FinishedPosition } from '@/lib/stock/positions'
import { cn } from '@/lib/utils'
import { MovementsPanel } from '../movements-panel'
import { RecordCountDialog } from '../record-count-dialog'
import { AdjustStockDialog } from '../adjust-stock-dialog'

const COUNT_BADGE: Record<FinishedPosition['count_state'], string> = {
  never: 'never_counted',
  stale: 'count_stale',
  fresh: 'counted',
}

const CHIP_ON = 'rounded-full border border-gray-900 bg-gray-900 px-3 py-1 text-xs font-medium text-white'
const CHIP_OFF = 'rounded-full border border-gray-300 bg-white px-3 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50'

function Num({ value, tone }: { value: number; tone?: 'muted' | 'bad' }) {
  return (
    <span
      className={cn(
        'tabular-nums',
        tone === 'bad' ? 'font-semibold text-red-700' : tone === 'muted' ? 'text-gray-400' : 'text-gray-900',
      )}
    >
      {value}
    </span>
  )
}

export default function FinishedBoard({ rows, canEdit }: { rows: FinishedPosition[]; canEdit: boolean }) {
  const [view, setView] = usePersistedView<StockBoardView>(
    'stock-board',
    { v: 1, q: '', warehouse: '' },
    parseStockBoardView,
  )
  const [selected, setSelected] = useState<FinishedPosition | null>(null)

  const needle = view.q.trim().toLowerCase()
  const filtered = rows.filter(
    (r) =>
      (view.warehouse === '' || r.warehouse_code === view.warehouse) &&
      (needle === '' || `${r.sku} ${r.product_name ?? ''}`.toLowerCase().includes(needle)),
  )
  const byWarehouse = new Map<string, FinishedPosition[]>()
  for (const r of filtered) {
    const list = byWarehouse.get(r.warehouse_code) ?? []
    list.push(r)
    byWarehouse.set(r.warehouse_code, list)
  }
  // Known warehouses first, in their fixed order, then anything else the data holds.
  const order = [
    ...STOCK_WAREHOUSES.filter((w) => byWarehouse.has(w)),
    ...[...byWarehouse.keys()].filter((w) => !(STOCK_WAREHOUSES as readonly string[]).includes(w)).sort(),
  ]

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className={view.warehouse === '' ? CHIP_ON : CHIP_OFF} onClick={() => setView({ ...view, warehouse: '' })}>
            All
          </button>
          {STOCK_WAREHOUSES.map((w) => (
            <button
              key={w}
              type="button"
              className={view.warehouse === w ? CHIP_ON : CHIP_OFF}
              onClick={() => setView({ ...view, warehouse: w })}
            >
              {w}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <SearchBox value={view.q} onChange={(q) => setView({ ...view, q })} placeholder="Search SKU or product…" />
          {canEdit && (
            <>
              <RecordCountDialog itemKind="finished" defaultWarehouse={view.warehouse || SRO_WAREHOUSE} />
              <AdjustStockDialog itemKind="finished" defaultWarehouse={view.warehouse || SRO_WAREHOUSE} />
            </>
          )}
        </div>
      </div>

      {order.length === 0 ? (
        <EmptyState
          icon={<Boxes className="w-7 h-7" />}
          title={needle ? 'No matching stock' : 'No stock recorded yet'}
          description={
            needle
              ? `Nothing matches “${view.q}”.`
              : 'Record a count to put the first figures on the board.'
          }
        />
      ) : (
        order.map((warehouse) => {
          const items = byWarehouse.get(warehouse) ?? []
          const isSro = warehouse === SRO_WAREHOUSE
          return (
            <div key={warehouse} data-stock-warehouse={warehouse}>
              <div className="flex items-center gap-2 mb-3">
                <span className="text-sm font-medium text-gray-900 px-2 py-1 bg-blue-50 border border-blue-200 rounded-lg font-mono">
                  {warehouse}
                </span>
                <span className="text-sm text-gray-600">{entityLabel(warehouse, '')}</span>
                <span className="text-xs text-gray-400">{items.length} SKU{items.length === 1 ? '' : 's'}</span>
              </div>
              <div className="overflow-auto rounded-lg border border-gray-200 bg-white">
                <table className="w-full min-w-[720px] text-sm">
                  <thead>
                    <tr className="border-b border-gray-200 bg-gray-50">
                      {['SKU', 'Product', 'On hand', 'Committed', 'Available', 'On order', 'In transit', ...(isSro ? ['In production'] : []), 'Last counted'].map((h) => (
                        <th key={h} className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider whitespace-nowrap">
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((r) => (
                      <tr
                        key={`${r.warehouse_code}|${r.sku}`}
                        className="border-b border-gray-100 last:border-0 hover:bg-gray-50 cursor-pointer"
                        onClick={() => setSelected(r)}
                      >
                        <td className="px-4 py-3"><span className="font-mono text-xs text-echo-orange">{r.sku}</span></td>
                        <td className="px-4 py-3 text-gray-600">{r.product_name ?? '—'}</td>
                        <td className="px-4 py-3 font-semibold"><Num value={r.on_hand} /></td>
                        <td className="px-4 py-3"><Num value={r.committed} tone={r.committed === 0 ? 'muted' : undefined} /></td>
                        <td className="px-4 py-3"><Num value={r.available} tone={r.available < 0 ? 'bad' : undefined} /></td>
                        <td className="px-4 py-3"><Num value={r.inbound_on_order} tone={r.inbound_on_order === 0 ? 'muted' : undefined} /></td>
                        <td className="px-4 py-3"><Num value={r.inbound_in_transit} tone={r.inbound_in_transit === 0 ? 'muted' : undefined} /></td>
                        {isSro && (
                          <td className="px-4 py-3"><Num value={r.in_production} tone={r.in_production === 0 ? 'muted' : undefined} /></td>
                        )}
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-2">
                            <StatusBadge status={COUNT_BADGE[r.count_state]} />
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
            </div>
          )
        })
      )}

      {selected && (
        <MovementsPanel
          key={`${selected.warehouse_code}|${selected.sku}`}
          itemKind="finished"
          warehouse={selected.warehouse_code}
          sku={selected.sku}
          title={`${selected.sku} at ${selected.warehouse_code}`}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  )
}
