'use client'

// page-state: none (two buttons and a busy flag. Nothing here is a draft: the
// only durable thing this screen produces is the decision itself, which is
// written the moment it is made.)

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Factory, Warehouse } from 'lucide-react'
import { raiseManufacturingPo } from '@/app/actions/purchase-orders/raise-manufacturing-po'
import { fulfilFromSroStock } from '@/app/actions/purchase-orders/fulfil-from-stock'
import type { OrderCapability } from '@/lib/manufacturing-capability'

type StockRow = { sku: string; onHand: number; lastCountedAt: string | null }

/**
 * The order has reached SRO. They now choose: send it out of stock they already
 * hold in Kosice, or build it.
 *
 * Until 8 Sep 2026 approving the leg answered this on its own by raising the
 * Bamida order immediately. This card is what that approval used to skip.
 */
export default function FulfilmentCard({
  poId,
  canAct,
  canViewBom,
  capability,
  sroStock,
}: {
  poId: string
  canAct: boolean
  canViewBom: boolean
  capability: OrderCapability | null
  sroStock: StockRow[]
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [busy, setBusy] = useState<'stock' | 'manufacture' | null>(null)

  const neverCounted = sroStock.length > 0 && sroStock.every((s) => s.lastCountedAt === null)

  function manufacture() {
    setBusy('manufacture')
    startTransition(async () => {
      const res = await raiseManufacturingPo({ sro_po_id: poId })
      setBusy(null)
      if (!res.ok) toast.error(res.error)
      else toast.success(`Manufacturing order ${res.po_number} raised. Send it to Bamida next.`)
      router.refresh()
    })
  }

  function fromStock() {
    setBusy('stock')
    startTransition(async () => {
      const res = await fulfilFromSroStock({ sro_po_id: poId })
      setBusy(null)
      if (!res.ok) toast.error(res.error)
      else toast.success('Recorded: this order is being fulfilled from SRO stock.')
      router.refresh()
    })
  }

  return (
    <div className="rounded-xl border border-[#2a2a2a] bg-[#141414] p-5">
      <h2 className="text-base font-semibold text-white" style={{ fontFamily: 'Varela Round, sans-serif' }}>
        How is this order being fulfilled?
      </h2>
      <p className="text-sm text-[#6b7280] mt-1">
        Fulfil it from stock already at EB SRO, or manufacture it. Choosing manufacture raises the
        purchase order on Bamida; choosing stock raises nothing.
      </p>

      <div className="grid gap-4 md:grid-cols-2 mt-5">
        {/* ---------- Stock ---------- */}
        <div className="rounded-lg border border-[#2a2a2a] bg-[#1a1a1a] p-4 flex flex-col">
          <div className="flex items-center gap-2 text-sm font-medium text-[#e5e5e5]">
            <Warehouse className="w-4 h-4 text-[#6b7280]" /> From EB SRO stock
          </div>

          <div className="mt-3 flex-1 space-y-1.5 text-sm">
            {sroStock.length === 0 && <p className="text-[#4b5563]">This order has no SKUs to check.</p>}
            {sroStock.map((row) => (
              <div key={row.sku} className="flex justify-between gap-3">
                <span className="font-mono text-[#9ca3af]">{row.sku}</span>
                <span className="tabular-nums text-[#e5e5e5]">
                  {row.lastCountedAt === null ? 'never counted' : `${row.onHand} on hand`}
                </span>
              </div>
            ))}
          </div>

          {neverCounted && (
            <p className="mt-3 text-xs text-[#6b7280]">
              EB SRO has never held a counted stock figure, so the Hub cannot confirm this from here.
              Choose it only if you know the barriers are on the shelf.
            </p>
          )}

          <button
            onClick={fromStock}
            disabled={!canAct || pending}
            className="mt-4 w-full px-4 py-2 text-sm font-medium rounded-lg border border-[#2a2a2a] text-[#e5e5e5] hover:bg-[#222] disabled:opacity-50 transition-colors"
          >
            {busy === 'stock' ? 'Recording...' : 'Fulfil from stock'}
          </button>
        </div>

        {/* ---------- Manufacture ---------- */}
        <div className="rounded-lg border border-[#2a2a2a] bg-[#1a1a1a] p-4 flex flex-col">
          <div className="flex items-center gap-2 text-sm font-medium text-[#e5e5e5]">
            <Factory className="w-4 h-4 text-[#6b7280]" /> Manufacture at Bamida
          </div>

          <div className="mt-3 flex-1 space-y-3 text-sm">
            {!canViewBom && (
              <p className="text-[#4b5563]">
                You cannot see the bill of materials, so the buildable figure is hidden.
              </p>
            )}
            {canViewBom &&
              (capability?.lines ?? []).map((line) => (
                <div key={line.sku}>
                  <div className="flex justify-between gap-3">
                    <span className="font-mono text-[#9ca3af]">{line.sku}</span>
                    <span className="tabular-nums text-[#e5e5e5]">
                      {!line.computable
                        ? 'bill of materials not confirmed yet'
                        : line.maxBuildable === null
                          ? 'not computable'
                          : `max buildable now: ${line.maxBuildable}`}
                    </span>
                  </div>

                  {line.shortages.length > 0 && (
                    <div className="mt-1.5 rounded-md border border-amber-900/60 bg-amber-950/40 px-3 py-2">
                      <p className="text-xs font-medium text-amber-300">
                        Short for {line.quantity} units. Bamida will still be asked to build, and told
                        what is missing.
                      </p>
                      <ul className="mt-1 space-y-0.5 text-xs text-amber-200/80">
                        {line.shortages.map((s) => (
                          <li key={s.code} className="tabular-nums">
                            {s.description ?? s.code}: need {s.need}, have {s.have}, short {s.short}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {line.computable && line.bindingDescription && line.shortages.length === 0 && (
                    <p className="mt-1 text-xs text-[#4b5563]">
                      Limited by {line.bindingDescription}.
                    </p>
                  )}

                  {line.unjoined.length > 0 && (
                    <p className="mt-1 text-xs text-[#6b7280]">
                      {line.unjoined.length} component{line.unjoined.length === 1 ? '' : 's'} have no
                      stock card, so they are unknown rather than counted as zero.
                    </p>
                  )}

                  {line.mappingProvisional && line.computable && (
                    <p className="mt-1 text-xs text-[#4b5563]">
                      The SKU to model mapping is still provisional. Treat the figure as a guide.
                    </p>
                  )}
                </div>
              ))}
          </div>

          <button
            onClick={manufacture}
            disabled={!canAct || pending}
            className="mt-4 w-full px-4 py-2 bg-[#FF7026] hover:bg-[#f2641b] text-white text-sm font-medium rounded-lg disabled:opacity-50 transition-colors"
          >
            {busy === 'manufacture' ? 'Raising...' : 'Manufacture'}
          </button>
        </div>
      </div>

      {!canAct && (
        <p className="mt-4 text-xs text-[#4b5563]">
          Read only. You need po.create to make this decision.
        </p>
      )}
    </div>
  )
}
