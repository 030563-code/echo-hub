'use client'

// page-state: none (opened per row, nothing typed)

import { useEffect, useState } from 'react'
import { X, Loader2 } from 'lucide-react'
import StatusBadge from '@/components/board/StatusBadge'
import { loadRowMovements } from './actions'
import type { MovementRow } from '@/lib/stock/board-data'
import type { ItemKind } from '@/lib/stock/movements'

function refHref(row: MovementRow): string | null {
  if (row.ref_type === 'po_shipment' || row.ref_type === 'po_manufacturing') return `/purchase-orders/${row.ref_id}`
  return null
}

function when(iso: string): string {
  return new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
}

/** The last 50 movements behind one row, in a fixed right panel like the PO board's. */
export function MovementsPanel({
  itemKind,
  warehouse,
  sku,
  title,
  onClose,
}: {
  itemKind: ItemKind
  warehouse: string
  sku: string
  title: string
  onClose: () => void
}) {
  const [rows, setRows] = useState<MovementRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Every setState lives inside the promise, never in the effect body (the
  // React compiler lint rejects a synchronous setState in an effect). The
  // parent keys this panel on the row, so switching rows is a fresh mount
  // with fresh state rather than a reset here.
  useEffect(() => {
    let live = true
    loadRowMovements({ itemKind, warehouse, sku }).then((res) => {
      if (!live) return
      if (res.success) setRows(res.data)
      else setError(res.error)
    })
    return () => {
      live = false
    }
  }, [itemKind, warehouse, sku])

  return (
    <div className="fixed inset-y-0 right-0 w-full max-w-md sm:w-[28rem] bg-white border-l border-gray-200 z-50 flex flex-col shadow-2xl">
      <div className="flex items-start justify-between gap-3 border-b border-gray-200 px-5 py-4">
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-gray-500">Movements</p>
          <h2 className="text-base font-semibold text-gray-900">{title}</h2>
        </div>
        <button type="button" onClick={onClose} aria-label="Close" className="p-2 -m-2 text-gray-400 hover:text-gray-900">
          <X className="w-4 h-4" />
        </button>
      </div>
      <div className="flex-1 overflow-y-auto px-5 py-4">
        {error && <p className="text-sm text-red-700">{error}</p>}
        {!error && rows === null && (
          <p className="flex items-center gap-2 text-sm text-gray-500">
            <Loader2 className="w-4 h-4 animate-spin" /> Loading…
          </p>
        )}
        {rows && rows.length === 0 && <p className="text-sm text-gray-500">No movements yet. The level has never changed through the ledger.</p>}
        {rows && rows.length > 0 && (
          <ul className="divide-y divide-gray-100">
            {rows.map((m) => {
              const href = refHref(m)
              return (
                <li key={m.id} className="py-3 text-sm">
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-2">
                      <StatusBadge status={m.kind} />
                      {m.estimated && <span className="text-xs text-amber-700">estimated</span>}
                    </div>
                    <span className={`tabular-nums font-semibold ${m.quantity < 0 ? 'text-red-700' : 'text-emerald-700'}`}>
                      {m.quantity > 0 ? `+${m.quantity}` : m.quantity}
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-gray-500">
                    balance {m.balance_after} · {when(m.created_at)} · {m.created_by ?? 'the Hub'}
                    {href ? (
                      <>
                        {' · '}
                        <a href={href} className="underline hover:no-underline">
                          {m.ref_type === 'po_shipment' ? 'shipment' : 'order'}
                        </a>
                      </>
                    ) : null}
                  </p>
                  {m.note && <p className="mt-1 text-xs text-gray-600">{m.note}</p>}
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </div>
  )
}
