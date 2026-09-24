'use client'
// page-state: none (the durable copy is the transport_shipment_line rows. Save writes the whole
// list at once, so nothing typed here is the only copy of itself for longer than one edit.)

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Pencil, Plus, Trash2, FileSpreadsheet } from 'lucide-react'
import { toast } from 'sonner'
import { saveShipmentContents } from '@/app/actions/transport/shipments'
import {
  contentsSummary,
  suggestedPallets,
  type DepotProductOption,
  type ShipmentLine,
  type ShipmentLineInput,
} from '@/lib/transport/shipment'

/**
 * What is on a shipment, one line per product, the way Dave's tab has one column per barrier type.
 *
 * Dean, 24 Sep 2026: "You must also be able to edit shipments to be able to add what products are
 * on the container. for example spot 244498887 doesnt have any products or pallets linked to it."
 */

type Target = { spotId: string } | { id: string }

interface Draft {
  key: string
  id: string | null
  productCode: string
  description: string
  quantity: string
  pallets: string
  groupOrderNo: string
  localOrderNo: string
}

let seq = 0
const nextKey = () => `line-${++seq}`

function toDraft(l: Pick<ShipmentLine, 'productCode' | 'description' | 'quantity' | 'pallets' | 'groupOrderNo' | 'localOrderNo'> & { id: string | null }): Draft {
  return {
    key: nextKey(),
    id: l.id,
    productCode: l.productCode,
    description: l.description ?? '',
    quantity: String(l.quantity),
    pallets: l.pallets == null ? '' : String(l.pallets),
    groupOrderNo: l.groupOrderNo ?? '',
    localOrderNo: l.localOrderNo ?? '',
  }
}

const blank = (): Draft => ({
  key: nextKey(),
  id: null,
  productCode: '',
  description: '',
  quantity: '',
  pallets: '',
  groupOrderNo: '',
  localOrderNo: '',
})

const num = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 2 })

export default function ShipmentContents({
  target,
  depotName,
  localOrderLabel,
  lines,
  products,
  fromSheet,
}: {
  target: Target
  depotName: string
  /** "USA / Canada order" for a North American depot, as Dave's tab calls it. */
  localOrderLabel: string
  lines: ShipmentLine[]
  products: DepotProductOption[]
  /** What Dave's sheet lists for this shipment, offered when nothing is listed here yet. */
  fromSheet: ShipmentLineInput[]
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState<Draft[]>([])
  const [pending, startTransition] = useTransition()
  const router = useRouter()
  const productBy = new Map(products.map((p) => [p.code.toUpperCase(), p]))
  const listId = `products-${'spotId' in target ? target.spotId : target.id}`

  function start(from: Draft[]) {
    setDraft(from.length ? from : [blank()])
    setEditing(true)
  }

  function change(key: string, field: keyof Omit<Draft, 'key' | 'id'>, value: string) {
    setDraft((rows) =>
      rows.map((r) => {
        if (r.key !== key) return r
        const next = { ...r, [field]: value }
        // Choosing a product fills what the Hub knows about it, and never overwrites what was typed.
        if (field === 'productCode' || field === 'quantity') {
          const product = productBy.get(next.productCode.trim().toUpperCase())
          if (field === 'productCode' && product && !r.description) next.description = product.description ?? ''
          const pallets = suggestedPallets(product?.family ?? null, Number(next.quantity))
          if (pallets != null && (!r.pallets || r.pallets === String(suggestedPallets(product?.family ?? null, Number(r.quantity))))) {
            next.pallets = String(pallets)
          }
        }
        return next
      }),
    )
  }

  function save() {
    const payload: ShipmentLineInput[] = []
    for (const [i, r] of draft.entries()) {
      if (!r.productCode.trim() && !r.quantity.trim()) continue
      const quantity = Number(r.quantity)
      const pallets = r.pallets.trim() === '' ? null : Number(r.pallets)
      const problem = !r.productCode.trim()
        ? `Line ${i + 1} needs a product.`
        : !(quantity > 0)
          ? `Line ${i + 1} needs a quantity.`
          : pallets != null && !(pallets >= 0)
            ? `Line ${i + 1}: pallets is a number.`
            : null
      if (problem) {
        toast.error(problem)
        return
      }
      payload.push({
        id: r.id,
        productCode: r.productCode.trim(),
        description: r.description.trim() || null,
        quantity,
        pallets,
        groupOrderNo: r.groupOrderNo.trim() || null,
        localOrderNo: r.localOrderNo.trim() || null,
      })
    }
    startTransition(async () => {
      try {
        const res = await saveShipmentContents({ target, lines: payload })
        if (!res.success) {
          toast.error(res.error)
          return
        }
        toast.success(res.message)
        setEditing(false)
        router.refresh()
      } catch {
        toast.error('That did not go through. Please try again.')
      }
    })
  }

  const summary = contentsSummary(lines)
  const sheetSummary = contentsSummary(fromSheet.map((l) => ({ productCode: l.productCode, quantity: l.quantity, pallets: l.pallets })))

  return (
    <section className="mt-5 rounded-xl border border-gray-200 bg-white p-5">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-gray-900" style={{ fontFamily: 'Varela Round, sans-serif' }}>
            Contents
          </h2>
          <p className="mt-0.5 text-sm text-gray-500">{summary ?? 'Nothing listed yet.'}</p>
        </div>
        {!editing && lines.length > 0 && (
          <button
            type="button"
            onClick={() => start(lines.map((l) => toDraft(l)))}
            className="inline-flex items-center gap-1.5 rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50"
          >
            <Pencil className="h-3.5 w-3.5" /> Edit
          </button>
        )}
      </div>

      {!editing && lines.length === 0 && (
        <div className="flex flex-wrap items-center gap-3">
          {fromSheet.length > 0 && (
            <div className="flex w-full flex-wrap items-center justify-between gap-3 rounded-lg border border-[#025945]/20 bg-[#025945]/5 px-4 py-3">
              <p className="flex items-center gap-2 text-sm text-gray-800">
                <FileSpreadsheet className="h-4 w-4 shrink-0 text-[#025945]" />
                Dave&apos;s sheet lists {sheetSummary} for this shipment.
              </p>
              <button
                type="button"
                onClick={() => start(fromSheet.map((l) => toDraft({ ...l, id: null })))}
                className="shrink-0 rounded-lg bg-[#025945] px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-[#03674f]"
              >
                Start from the sheet
              </button>
            </div>
          )}
          <button
            type="button"
            onClick={() => start([])}
            className="inline-flex items-center gap-1.5 rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50"
          >
            <Plus className="h-3.5 w-3.5" /> Add what is on it
          </button>
        </div>
      )}

      {!editing && lines.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-sm">
            <thead>
              <tr className="border-b border-gray-100 text-left text-xs text-gray-500">
                <th className="py-2 pr-4 font-medium">Product</th>
                <th className="py-2 pr-4 text-right font-medium">Quantity</th>
                <th className="py-2 pr-4 text-right font-medium">Pallets</th>
                <th className="py-2 pr-4 font-medium">Group order</th>
                <th className="py-2 font-medium">{localOrderLabel}</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((l) => (
                <tr key={l.id} className="border-b border-gray-50 last:border-0">
                  <td className="py-2.5 pr-4">
                    <p className="font-medium tabular-nums text-gray-900">{l.productCode}</p>
                    {l.description && <p className="text-xs text-gray-500">{l.description}</p>}
                  </td>
                  <td className="py-2.5 pr-4 text-right tabular-nums text-gray-900">{num(l.quantity)}</td>
                  <td className="py-2.5 pr-4 text-right tabular-nums text-gray-900">{l.pallets == null ? '—' : num(l.pallets)}</td>
                  <td className="py-2.5 pr-4 tabular-nums text-gray-700">{l.groupOrderNo ?? '—'}</td>
                  <td className="py-2.5 tabular-nums text-gray-700">{l.localOrderNo ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {editing && (
        <div>
          <datalist id={listId}>
            {products.map((p) => (
              <option key={p.code} value={p.code}>
                {p.description ?? p.family ?? ''}
              </option>
            ))}
          </datalist>
          <div className="space-y-3">
            {draft.map((r, i) => {
              const code = r.productCode.trim()
              const known = !code || productBy.has(code.toUpperCase())
              return (
                <div key={r.key} className="rounded-lg border border-gray-200 p-3">
                  <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-[minmax(9rem,1fr)_minmax(10rem,1.4fr)_6.5rem_6rem_minmax(7rem,1fr)_minmax(7rem,1fr)_auto]">
                    <label className="block">
                      <span className="text-xs text-gray-500">Product</span>
                      <input
                        list={listId}
                        value={r.productCode}
                        onChange={(e) => change(r.key, 'productCode', e.target.value)}
                        aria-label={`Line ${i + 1} product`}
                        placeholder="H9BALT"
                        maxLength={40}
                        className="mt-1 w-full rounded-lg border border-gray-300 px-2.5 py-1.5 text-sm uppercase focus:border-[#025945] focus:outline-none"
                      />
                    </label>
                    <label className="block">
                      <span className="text-xs text-gray-500">Description</span>
                      <input
                        value={r.description}
                        onChange={(e) => change(r.key, 'description', e.target.value)}
                        aria-label={`Line ${i + 1} description`}
                        maxLength={200}
                        className="mt-1 w-full rounded-lg border border-gray-300 px-2.5 py-1.5 text-sm focus:border-[#025945] focus:outline-none"
                      />
                    </label>
                    <label className="block">
                      <span className="text-xs text-gray-500">Quantity</span>
                      <input
                        inputMode="decimal"
                        value={r.quantity}
                        onChange={(e) => change(r.key, 'quantity', e.target.value)}
                        aria-label={`Line ${i + 1} quantity`}
                        className="mt-1 w-full rounded-lg border border-gray-300 px-2.5 py-1.5 text-right text-sm tabular-nums focus:border-[#025945] focus:outline-none"
                      />
                    </label>
                    <label className="block">
                      <span className="text-xs text-gray-500">Pallets</span>
                      <input
                        inputMode="decimal"
                        value={r.pallets}
                        onChange={(e) => change(r.key, 'pallets', e.target.value)}
                        aria-label={`Line ${i + 1} pallets`}
                        className="mt-1 w-full rounded-lg border border-gray-300 px-2.5 py-1.5 text-right text-sm tabular-nums focus:border-[#025945] focus:outline-none"
                      />
                    </label>
                    <label className="block">
                      <span className="text-xs text-gray-500">Group order</span>
                      <input
                        value={r.groupOrderNo}
                        onChange={(e) => change(r.key, 'groupOrderNo', e.target.value)}
                        aria-label={`Line ${i + 1} Group order`}
                        maxLength={40}
                        className="mt-1 w-full rounded-lg border border-gray-300 px-2.5 py-1.5 text-sm focus:border-[#025945] focus:outline-none"
                      />
                    </label>
                    <label className="block">
                      <span className="text-xs text-gray-500">{localOrderLabel}</span>
                      <input
                        value={r.localOrderNo}
                        onChange={(e) => change(r.key, 'localOrderNo', e.target.value)}
                        aria-label={`Line ${i + 1} ${localOrderLabel}`}
                        maxLength={40}
                        className="mt-1 w-full rounded-lg border border-gray-300 px-2.5 py-1.5 text-sm focus:border-[#025945] focus:outline-none"
                      />
                    </label>
                    <div className="flex items-end">
                      <button
                        type="button"
                        onClick={() => setDraft((rows) => rows.filter((x) => x.key !== r.key))}
                        aria-label={`Remove line ${i + 1}`}
                        className="rounded-lg p-2 text-gray-400 transition-colors hover:bg-red-50 hover:text-red-600"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  </div>
                  {!known && (
                    <p className="mt-2 text-xs text-amber-700">
                      {code} is not one of {depotName}&apos;s items in the Hub. It is kept as typed, but a Xero PO needs a real item code.
                    </p>
                  )}
                </div>
              )
            })}
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => setDraft((rows) => [...rows, blank()])}
              className="inline-flex items-center gap-1.5 rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50"
            >
              <Plus className="h-3.5 w-3.5" /> Add a line
            </button>
            <span className="flex-1" />
            <button
              type="button"
              onClick={() => setEditing(false)}
              disabled={pending}
              className="px-3 py-1.5 text-sm text-gray-500 hover:text-gray-800"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={save}
              disabled={pending}
              className="rounded-lg bg-[#025945] px-4 py-1.5 text-sm font-medium text-white transition-colors hover:bg-[#03674f] disabled:opacity-60"
            >
              {pending ? 'Saving' : 'Save contents'}
            </button>
          </div>
          <p className="mt-2 text-xs text-gray-400">
            Pallets fill in at 70 barriers a pallet (30 for H8) when a barrier is chosen. Type over it when the factory packed it differently.
          </p>
        </div>
      )}
    </section>
  )
}
