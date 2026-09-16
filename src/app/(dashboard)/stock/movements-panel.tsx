'use client'

// page-state: none (an adjustment draft is deliberately NOT restored: a delta
// and a reason typed days ago must never reappear over today's numbers)

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { X, Loader2 } from 'lucide-react'
import StatusBadge from '@/components/board/StatusBadge'
import { Button } from '@/components/ui/button'
import { loadRowMovements, recordStockAdjustmentAction } from './actions'
import type { MovementRow } from '@/lib/stock/board-data'
import type { ItemKind } from '@/lib/stock/movements'

function refHref(row: MovementRow): string | null {
  if (row.ref_type === 'po_shipment' || row.ref_type === 'po_manufacturing') return `/purchase-orders/${row.ref_id}`
  return null
}

function when(iso: string): string {
  return new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
}

/**
 * One row's panel: what its level is, how to change it, and every movement
 * behind it.
 *
 * Dean, 16 Sep 2026: "why do I have to click a button Adjust in the Stock
 * Materials why can't I just click on the material itself and it pops up with
 * the adjust settings?" So the adjustment lives here, on the row you clicked,
 * with the component already chosen. The board's Adjust button stays for the
 * other case, a code that has no row on the board yet.
 *
 * The history sits under the form on purpose: the balance you are about to
 * change, and how it got there, is exactly what you want in front of you before
 * you type a number.
 */
export function MovementsPanel({
  itemKind,
  warehouse,
  sku,
  title,
  canEdit = false,
  onClose,
}: {
  itemKind: ItemKind
  warehouse: string
  sku: string
  title: string
  /** stock.edit. Without it this is a read-only history, as it always was. */
  canEdit?: boolean
  onClose: () => void
}) {
  const router = useRouter()
  const [rows, setRows] = useState<MovementRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [reload, setReload] = useState(0)
  const [delta, setDelta] = useState('')
  const [note, setNote] = useState('')
  const [pending, setPending] = useState(false)
  /**
   * Minted at the first submit rather than on mount, so it is stable across a
   * retry of the same form (a double click applies once) and never runs during
   * render, where the server and the client would disagree.
   */
  const refId = useRef('')

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
  }, [itemKind, warehouse, sku, reload])

  /** The ledger's own latest balance, which is what an adjustment moves. */
  const balance = rows && rows.length > 0 ? rows[0].balance_after : null

  const n = Number(delta)
  const valid = delta.trim() !== '' && Number.isFinite(n) && n !== 0 && note.trim().length >= 5

  const submit = async () => {
    if (pending || !valid) return
    if (!refId.current) refId.current = crypto.randomUUID()
    setPending(true)
    try {
      const res = await recordStockAdjustmentAction({
        itemKind,
        warehouse,
        sku,
        delta: n,
        note: note.trim(),
        refId: refId.current,
      })
      if (!res.success) {
        toast.error(res.error, { duration: 12000 })
        return
      }
      toast.success(
        res.data.applied > 0 ? `${sku} adjusted by ${n > 0 ? '+' : ''}${n} at ${warehouse}.` : 'Already applied.',
        { duration: 8000 }
      )
      // A fresh reference for the next adjustment, the form cleared, and both
      // the history here and the numbers on the board behind re-read, so the
      // change you just made is visible where you made it.
      refId.current = ''
      setDelta('')
      setNote('')
      setRows(null)
      setReload((r) => r + 1)
      router.refresh()
    } finally {
      setPending(false)
    }
  }

  return (
    <div className="fixed inset-y-0 right-0 w-full max-w-md sm:w-[28rem] bg-white border-l border-gray-200 z-50 flex flex-col shadow-2xl">
      <div className="flex items-start justify-between gap-3 border-b border-gray-200 px-5 py-4">
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-gray-500">
            {itemKind === 'finished' ? 'Finished goods' : 'Material'}
          </p>
          <h2 className="text-base font-semibold text-gray-900">{title}</h2>
          {/* Always rendered, so the header does not jump when the history
              lands a moment after the panel opens. */}
          <p className="mt-0.5 text-xs text-gray-500">
            {rows === null ? (
              'Reading the ledger…'
            ) : balance === null ? (
              'Nothing in the ledger yet'
            ) : (
              <>
                On hand in the ledger <span className="font-semibold tabular-nums text-gray-700">{balance}</span>
              </>
            )}
          </p>
        </div>
        <button type="button" onClick={onClose} aria-label="Close" className="p-2 -m-2 text-gray-400 hover:text-gray-900">
          <X className="w-4 h-4" />
        </button>
      </div>

      {canEdit && (
        <div className="border-b border-gray-200 bg-gray-50 px-5 py-4">
          <p className="text-sm font-medium text-gray-900">Adjust this level</p>
          <p className="mt-0.5 text-xs text-gray-500">
            A signed change with the reason. For a full recount use Record count on the board.
          </p>
          <div className="mt-3 grid gap-3">
            <label className="text-sm">
              <span className="block text-xs font-medium text-gray-600">Change (negative to deduct)</span>
              <input
                value={delta}
                onChange={(e) => setDelta(e.target.value)}
                inputMode="decimal"
                placeholder="-2"
                className="mt-1 w-full rounded-md border border-gray-300 bg-white px-2 py-2 text-sm tabular-nums"
              />
            </label>
            <label className="text-sm">
              <span className="block text-xs font-medium text-gray-600">Why (required)</span>
              <input
                value={note}
                onChange={(e) => setNote(e.target.value)}
                maxLength={300}
                placeholder="Two panels damaged on unloading"
                className="mt-1 w-full rounded-md border border-gray-300 bg-white px-2 py-2 text-sm"
              />
            </label>
            <div className="flex justify-end">
              <Button size="sm" onClick={submit} disabled={pending || !valid}>
                {pending && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
                Apply adjustment
              </Button>
            </div>
          </div>
        </div>
      )}

      <div className="flex-1 overflow-y-auto px-5 py-4">
        <p className="mb-3 text-xs font-medium uppercase tracking-wide text-gray-500">Movements</p>
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
