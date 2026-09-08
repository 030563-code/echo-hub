import Link from 'next/link'
import { notFound } from 'next/navigation'
import { ArrowLeft } from 'lucide-react'
import { createServerClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { getCapabilities } from '@/lib/authz'
import { chainNumber, displayPoNumber, legLabel } from '@/lib/po-number'
import { assessOrderCapability } from '@/lib/manufacturing-capability'
import type { PurchaseOrder } from '@/lib/erp-types'
import FulfilmentCard from './fulfilment-card'
import ManufacturingCard from './manufacturing-card'

export const dynamic = 'force-dynamic'

/**
 * One purchase order, and whatever has to happen to it next.
 *
 * This page exists because the email telling SRO an order has arrived has to
 * land somewhere specific. The board shows every order; this shows one, and the
 * decision it is waiting on.
 *
 * Two decisions live here, and only one of them at a time:
 *  - an approved EB_GROUP_TO_SRO leg is waiting for SRO to choose stock or
 *    manufacture,
 *  - a SRO_TO_SUPPLIER order is waiting to be sent to Bamida.
 */
export default async function PurchaseOrderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const caps = await getCapabilities()
  const supabase = await createServerClient()

  const { data: po } = await supabase
    .from('purchase_orders')
    .select('*, lines:purchase_order_lines(*)')
    .eq('id', id)
    .maybeSingle<PurchaseOrder & { fulfilment_type?: string | null }>()
  if (!po) notFound()

  const canAct = caps.has('po.create')
  const canViewCost = caps.has('cost.view')
  const canViewBom = caps.has('bom.view')

  const awaitingFulfilment = po.leg === 'EB_GROUP_TO_SRO' && po.status === 'approved'
  const isManufacturingOrder = po.leg === 'SRO_TO_SUPPLIER'

  // Only work out what Bamida could build when somebody is about to decide. The
  // figure costs three queries and is meaningless anywhere else on this page.
  const capability = awaitingFulfilment && canViewBom ? await assessOrderCapability(po.lines ?? []) : null

  // The stock branch. EB-SRO has never held a counted figure, so this will read
  // as "never counted" rather than as a zero that looks like a fact.
  let sroStock: Array<{ sku: string; onHand: number; lastCountedAt: string | null }> = []
  if (awaitingFulfilment) {
    const skus = Array.from(new Set((po.lines ?? []).map((l) => l.sku).filter(Boolean))) as string[]
    if (skus.length > 0) {
      const { data } = await supabase
        .from('warehouse_stock_levels')
        .select('sku, quantity_on_hand, last_counted_at')
        .eq('warehouse_code', 'EB-SRO')
        .in('sku', skus)
      const bySku = new Map((data ?? []).map((r) => [String(r.sku), r]))
      sroStock = skus.map((sku) => ({
        sku,
        onHand: Number(bySku.get(sku)?.quantity_on_hand ?? 0),
        lastCountedAt: (bySku.get(sku)?.last_counted_at as string | null) ?? null,
      }))
    }
  }

  // Whether this manufacturing order has already gone to Bamida, and what they
  // have said since. Service-role: po_manufacturing is not reachable by anon or
  // authenticated at all.
  let manufacturing: {
    sentAt: string | null
    sentTo: string[]
    sentWasTest: boolean
    estStart: string | null
    estFinish: string | null
    finishedAt: string | null
  } | null = null
  if (isManufacturingOrder) {
    const { data } = await createAdminClient()
      .from('po_manufacturing')
      .select('sent_at, sent_to, sent_was_test, est_start, est_finish, finished_at')
      .eq('po_id', po.id)
      .maybeSingle()
    manufacturing = {
      sentAt: data?.sent_at ?? null,
      sentTo: (data?.sent_to as string[] | null) ?? [],
      sentWasTest: data?.sent_was_test === true,
      estStart: data?.est_start ?? null,
      estFinish: data?.est_finish ?? null,
      finishedAt: data?.finished_at ?? null,
    }
  }

  const chain = chainNumber(po)

  return (
    <div className="p-6 max-w-5xl">
      <Link
        href="/purchase-orders"
        className="inline-flex items-center gap-1.5 text-sm text-[#6b7280] hover:text-white transition-colors"
      >
        <ArrowLeft className="w-4 h-4" /> Purchase orders
      </Link>

      <div className="mt-4 mb-6">
        <h1 className="text-2xl font-bold text-white" style={{ fontFamily: 'Varela Round, sans-serif' }}>
          {displayPoNumber(po.po_number)}
        </h1>
        <p className="text-sm text-[#6b7280] mt-1">
          {legLabel(po.leg)} · <span className="font-mono">{chain}</span> ·{' '}
          <span className="font-mono">{po.from_entity}</span> to <span className="font-mono">{po.to_entity}</span>
          {po.reference_po_number ? (
            <> · reference <span className="font-mono">{displayPoNumber(po.reference_po_number)}</span></>
          ) : null}
        </p>
      </div>

      <div className="rounded-xl border border-[#2a2a2a] bg-[#141414] overflow-hidden mb-6">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-[#1a1a1a] text-[10px] uppercase tracking-wider text-[#4b5563]">
              <th className="text-left font-medium px-4 py-2.5">SKU</th>
              <th className="text-left font-medium px-4 py-2.5">Product</th>
              <th className="text-right font-medium px-4 py-2.5">Quantity</th>
              {canViewCost && <th className="text-right font-medium px-4 py-2.5">Unit price</th>}
            </tr>
          </thead>
          <tbody>
            {(po.lines ?? []).map((line) => (
              <tr key={line.id} className="border-t border-[#222]">
                <td className="px-4 py-2.5 font-mono text-[#e5e5e5]">{line.sku}</td>
                <td className="px-4 py-2.5 text-[#9ca3af]">{line.product_name}</td>
                <td className="px-4 py-2.5 text-right tabular-nums text-[#e5e5e5]">{line.quantity}</td>
                {canViewCost && (
                  <td className="px-4 py-2.5 text-right tabular-nums text-[#6b7280]">
                    {line.unit_price == null ? '' : line.unit_price.toFixed(2)}
                  </td>
                )}
              </tr>
            ))}
            {(po.lines ?? []).length === 0 && (
              <tr>
                <td colSpan={canViewCost ? 4 : 3} className="px-4 py-8 text-center text-[#4b5563]">
                  This order has no lines.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {awaitingFulfilment && (
        <FulfilmentCard
          poId={po.id}
          canAct={canAct}
          canViewBom={canViewBom}
          capability={capability}
          sroStock={sroStock}
        />
      )}

      {isManufacturingOrder && manufacturing && (
        <ManufacturingCard poId={po.id} canAct={canAct} manufacturing={manufacturing} />
      )}

      {!awaitingFulfilment && !isManufacturingOrder && (
        <p className="text-sm text-[#6b7280]">
          Nothing is waiting on this order here. Its status is{' '}
          <span className="font-mono text-[#9ca3af]">{po.status}</span>.
        </p>
      )}
    </div>
  )
}
