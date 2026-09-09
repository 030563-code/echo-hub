import Link from 'next/link'
import { notFound } from 'next/navigation'
import { ArrowLeft } from 'lucide-react'
import { createServerClient } from '@/lib/supabase/server'
import { getCapabilities } from '@/lib/authz'
import { chainNumber, displayPoNumber, isFullyReceived, legLabel } from '@/lib/po-number'
import { entityPoCurrency } from '@/lib/po-currency'
import { entityLabel } from '@/lib/depot-constants'
import { deriveStage, effectiveStage, stageLabel } from '@/lib/po-lifecycle'
import { assessOrderCapability } from '@/lib/manufacturing-capability'
import { loadPurchaseOrderDetail } from '@/lib/po-detail'
import { loadCargoRequest, type CargoRequestRow } from '@/lib/cargo-request-store'
import DownloadPoPdfButton from '@/components/po/download-po-pdf-button'
import ShipmentSection from '@/components/po/shipment-section'
import AttachmentsSection from '@/components/po/attachments-section'
import CargoPoButton from '@/components/po/cargo-po-button'
import TimelineItem from '@/components/po/timeline-item'
import DetailSection from '@/components/po/detail-section'
import StatusBadge from '@/components/board/StatusBadge'
import FulfilmentCard from './fulfilment-card'
import ManufacturingCard from './manufacturing-card'
import CargoRequestCard from './cargo-request-card'
import ApprovalCard from './approval-card'
import StageControl from './stage-control'
import ReceiveButton from './receive-button'

export const dynamic = 'force-dynamic'

/**
 * One purchase order, and everything you can do to it.
 *
 * Dean, 9 Sep 2026: the email link takes you to the purchase order, but from
 * there you should be able to RUN it. Set where it sits, see things like the
 * fulfilment type, and change them from here.
 *
 * Before this, the page was a viewer with one decision card on it. Everything
 * else about an order (approve or reject it, log a delivery, look up its
 * shipment, its files, what it cost, where it sits on the board) existed only in
 * the board's drawer, which is the one place the emails do not link to. Nothing
 * here is a new power: it is the same components and the same server actions,
 * on the page a person is actually sent to.
 *
 * WHAT THIS PAGE DOES NOT DO. It never writes `purchase_orders.status`. There is
 * no status dropdown, and there is no Mark shipped, Mark delivered or Cancel.
 * Every status change is a side effect of a named button whose action already
 * owns its guard: approving raises the next tier and freezes the cost, choosing
 * stock or manufacture is a one-shot compare-and-set, and 'delivered' is reached
 * only by logging receipts, because that is what moves stock. A status written
 * by hand would skip all of it. The one state column the page does write is
 * `lifecycle_stage`, which is board placement and nothing else.
 */
export default async function PurchaseOrderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const caps = await getCapabilities()

  const canAct = caps.has('po.create')
  const canApprove = caps.has('po.approve')
  const canReceive = caps.has('po.receive')
  const canViewCost = caps.has('cost.view')
  const canViewBom = caps.has('bom.view')
  const canDetectShipment = caps.has('transport.view')
  const canManageAttachments = canAct || canApprove || canReceive
  const canMoveStage = canApprove || canReceive

  const detail = await loadPurchaseOrderDetail(id, canViewCost)
  if (!detail) notFound()
  const { po, chain, pdf, manufacturing } = detail

  // Exactly the conditions the rest of the Hub already uses, so this page and the
  // board can never disagree about what an order is waiting on.
  const awaitingApproval = po.source === 'hub' && po.status === 'requested'
  const awaitingFulfilment = po.leg === 'EB_GROUP_TO_SRO' && po.status === 'approved'
  const isManufacturingOrder = po.leg === 'SRO_TO_SUPPLIER'
  const canLogDelivery =
    canReceive &&
    po.source === 'hub' &&
    po.status === 'approved' &&
    po.leg === 'DEPOT_TO_EB_GROUP' &&
    !isFullyReceived(po.lines ?? [])

  const supabase = await createServerClient()

  // Only work out what Bamida could build when somebody is about to decide. The
  // figure costs four queries and is meaningless anywhere else on this page.
  const capability = awaitingFulfilment && canViewBom ? await assessOrderCapability(po.lines ?? []) : null

  // The stock branch. EB-SRO has never held a counted figure, so this reads as
  // "never counted" rather than as a zero that looks like a fact.
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

  // A Bamida order with no po_manufacturing row has simply not been sent yet,
  // which is exactly when somebody needs the Send to Bamida button. So the card
  // renders on the LEG, with an empty progress record, not on the row existing.
  const progress =
    manufacturing ??
    (isManufacturingOrder
      ? { sentAt: null, sentTo: [], sentWasTest: false, estStart: null, estFinish: null, finishedAt: null }
      : null)

  // The shipment request, drafted the moment Bamida pressed finished.
  let cargo: CargoRequestRow | null = null
  if (isManufacturingOrder) cargo = await loadCargoRequest(po.id)

  // The cost is entered on the root (depot) leg in that depot's currency and the
  // PDF converts into this leg's, so the rate comes from the root. Same rule the
  // board uses.
  const root = chain.find((l) => l.parent_po_id === null)
  const rootCurrency = entityPoCurrency(root?.from_entity ?? po.from_entity)

  const stage = effectiveStage(po)
  const derived = deriveStage(po)
  const tier = TIER_LABEL[po.leg] ?? po.leg

  return (
    <div className="p-6 max-w-5xl">
      <Link
        href="/purchase-orders"
        className="inline-flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-900 transition-colors"
      >
        <ArrowLeft className="w-4 h-4" /> Purchase orders
      </Link>

      <div className="mt-4 mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900" style={{ fontFamily: 'Varela Round, sans-serif' }}>
            {displayPoNumber(po.po_number)}
          </h1>
          <p className="text-sm text-gray-500 mt-1">
            {legLabel(po.leg)} · <span className="font-mono">{chainNumber(po)}</span> ·{' '}
            {entityLabel(po.from_entity)} to {entityLabel(po.to_entity)}
            {po.reference_po_number ? (
              <> · reference <span className="font-mono">{displayPoNumber(po.reference_po_number)}</span></>
            ) : null}
          </p>
          <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
            <StatusBadge status={po.status} />
            {po.fulfilment_type && <StatusBadge status={po.fulfilment_type} />}
            <span className="inline-flex items-center rounded-md border border-gray-200 bg-gray-50 px-2 py-0.5 text-xs font-medium text-gray-600">
              {stageLabel(stage)}
            </span>
          </div>
        </div>
        <DownloadPoPdfButton
          po={po}
          canViewCost={canViewCost}
          parties={pdf.parties}
          fx={pdf.fx}
          rootCurrency={rootCurrency}
        />
      </div>

      {/* The other legs of the same order. Three purchase orders is the chain by
          design, and until now the only way to see the others was the board. */}
      {chain.length > 1 && (
        <div className="rounded-xl border border-gray-200 bg-white p-5 mb-6">
          <p className="text-xs font-medium uppercase tracking-wider text-gray-500 mb-2.5">
            This order, end to end
          </p>
          <div className="flex flex-wrap gap-2">
            {chain.map((leg) => {
              const here = leg.id === po.id
              return (
                <Link
                  key={leg.id}
                  href={`/purchase-orders/${leg.id}`}
                  className={
                    here
                      ? 'rounded-lg border border-echo-orange bg-orange-50 px-3 py-2 text-xs'
                      : 'rounded-lg border border-gray-200 px-3 py-2 text-xs hover:bg-gray-50 transition-colors'
                  }
                >
                  <span className="block font-mono text-gray-900">{displayPoNumber(leg.po_number)}</span>
                  <span className="mt-1 flex items-center gap-1.5 text-gray-500">
                    {legLabel(leg.leg as typeof po.leg)}
                    <StatusBadge status={leg.status} />
                    {here ? <span>you are here</span> : null}
                  </span>
                </Link>
              )
            })}
          </div>
        </div>
      )}

      <div className="rounded-xl border border-gray-200 bg-white overflow-hidden mb-6">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-gray-50 text-[10px] uppercase tracking-wider text-gray-500">
              <th className="text-left font-medium px-4 py-2.5">SKU</th>
              <th className="text-left font-medium px-4 py-2.5">Product</th>
              <th className="text-right font-medium px-4 py-2.5">Quantity</th>
              <th className="text-right font-medium px-4 py-2.5">Received</th>
              {canViewCost && <th className="text-right font-medium px-4 py-2.5">Unit price</th>}
            </tr>
          </thead>
          <tbody>
            {(po.lines ?? []).map((line) => {
              const received = line.qty_received ?? 0
              const complete = received >= line.quantity
              return (
                <tr key={line.id} className="border-t border-gray-100">
                  <td className="px-4 py-2.5 font-mono text-gray-900">{line.sku}</td>
                  <td className="px-4 py-2.5 text-gray-600">{line.product_name}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums text-gray-900">{line.quantity}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums">
                    {received === 0 ? (
                      <span className="text-gray-400">none yet</span>
                    ) : (
                      <span className={complete ? 'text-emerald-700' : 'text-amber-700'}>
                        {received} of {line.quantity}
                      </span>
                    )}
                  </td>
                  {canViewCost && (
                    <td className="px-4 py-2.5 text-right tabular-nums text-gray-500">
                      {line.unit_price == null ? '' : line.unit_price.toFixed(2)}
                    </td>
                  )}
                </tr>
              )
            })}
            {(po.lines ?? []).length === 0 && (
              <tr>
                <td colSpan={canViewCost ? 5 : 4} className="px-4 py-8 text-center text-gray-400">
                  This order has no lines.
                </td>
              </tr>
            )}
          </tbody>
        </table>
        {(canLogDelivery || (po.source === 'hub' && po.status === 'approved' && po.leg !== 'DEPOT_TO_EB_GROUP')) && (
          <div className="border-t border-gray-100 px-4 py-3">
            {canLogDelivery ? (
              <ReceiveButton po={po} />
            ) : (
              // Physical goods land at the depot that ordered them, so the depot
              // leg is the single receiving point. The intercompany legs are
              // paperwork, not a delivery anybody can sign for.
              <p className="text-xs text-gray-400">
                Intercompany leg. Goods are received against the depot order.
              </p>
            )}
          </div>
        )}
      </div>

      {/* What this order is waiting on, and the one thing you can do about it. */}
      {awaitingApproval && (
        <div className="mb-6">
          <ApprovalCard
            poId={po.id}
            poNumber={po.po_number}
            tier={tier}
            leg={po.leg}
            status={po.status}
            source={po.source}
            canApprove={canApprove}
          />
        </div>
      )}

      {awaitingFulfilment && (
        <FulfilmentCard
          poId={po.id}
          canAct={canAct}
          canViewBom={canViewBom}
          capability={capability}
          sroStock={sroStock}
        />
      )}

      {isManufacturingOrder && progress && (
        <ManufacturingCard poId={po.id} canAct={canAct} manufacturing={progress} />
      )}

      {cargo && (canDetectShipment || canAct) && (
        <CargoRequestCard
          poId={po.id}
          canAct={canAct}
          draft={cargo.draft}
          sentAt={cargo.sentAt}
          sentTo={cargo.sentTo}
          sentWasTest={cargo.sentWasTest}
        />
      )}

      {!awaitingApproval && !awaitingFulfilment && !isManufacturingOrder && (
        <div className="rounded-xl border border-gray-200 bg-white p-5 mb-6">
          <h2 className="text-base font-semibold text-gray-900" style={{ fontFamily: 'Varela Round, sans-serif' }}>
            Next step
          </h2>
          <p className="mt-2 text-sm text-gray-600">{waitingOn(po.status, po.leg)}</p>
        </div>
      )}

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <div className="rounded-xl border border-gray-200 bg-white p-5">
          <h2
            className="text-base font-semibold text-gray-900 mb-4"
            style={{ fontFamily: 'Varela Round, sans-serif' }}
          >
            Shipment
          </h2>
          <ShipmentSection po={po} canDetect={canDetectShipment} />
          {awaitingFulfilment && canDetectShipment && (
            <div className="mt-4">
              <CargoPoButton po={po} />
            </div>
          )}
        </div>

        <div className="rounded-xl border border-gray-200 bg-white p-5">
          <h2
            className="text-base font-semibold text-gray-900 mb-4"
            style={{ fontFamily: 'Varela Round, sans-serif' }}
          >
            Files
          </h2>
          <AttachmentsSection po={po} canManage={canManageAttachments} />
        </div>
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <div className="rounded-xl border border-gray-200 bg-white p-5">
          <h2
            className="text-base font-semibold text-gray-900 mb-4"
            style={{ fontFamily: 'Varela Round, sans-serif' }}
          >
            History
          </h2>
          <div className="space-y-2.5">
            <TimelineItem label="Raised" date={po.created_at} by={po.requested_by} />
            {po.approved_at && <TimelineItem label="Approved" date={po.approved_at} by={po.approved_by} />}
            {po.decided_at && po.status === 'rejected' && (
              <TimelineItem label="Rejected" date={po.decided_at} by={po.decided_by} />
            )}
            {manufacturing?.sentAt && (
              <TimelineItem
                label={manufacturing.sentWasTest ? 'Sent to the test address, not Bamida' : 'Sent to Bamida'}
                date={manufacturing.sentAt}
                by={manufacturing.sentTo.join(', ') || null}
              />
            )}
            {manufacturing?.finishedAt && (
              <TimelineItem label="Bamida finished it" date={manufacturing.finishedAt} />
            )}
            {cargo?.sentAt && (
              <TimelineItem
                label={cargo.sentWasTest ? 'Shipment request sent to the test address' : 'Shipment request sent'}
                date={cargo.sentAt}
                by={cargo.sentTo.join(', ') || null}
              />
            )}
            {po.shipped_at && <TimelineItem label="Shipped" date={po.shipped_at} />}
            {po.delivered_at && <TimelineItem label="Delivered" date={po.delivered_at} />}
          </div>

          <div className="mt-5 space-y-3 border-t border-gray-100 pt-4">
            <DetailSection label="Delivery address">
              <p className="text-sm text-gray-900 whitespace-pre-line">
                {po.delivery_address || <span className="text-gray-400">Not recorded</span>}
              </p>
            </DetailSection>
            {po.notes && (
              <DetailSection label="Notes">
                <p className="text-sm text-gray-900 whitespace-pre-line">{po.notes}</p>
              </DetailSection>
            )}
          </div>
        </div>

        <div className="rounded-xl border border-gray-200 bg-white p-5">
          <h2
            className="text-base font-semibold text-gray-900 mb-4"
            style={{ fontFamily: 'Varela Round, sans-serif' }}
          >
            Where it sits
          </h2>
          <StageControl poId={po.id} current={stage} derived={derived} canMove={canMoveStage} />
        </div>
      </div>
    </div>
  )
}

const TIER_LABEL: Record<string, string> = {
  DEPOT_TO_EB_GROUP: 'Depot',
  EB_GROUP_TO_SRO: 'Group',
  SRO_TO_SUPPLIER: 'SRO',
}



/**
 * What is holding this order up, and where that happens. The page used to end on
 * "Nothing is waiting on this order here", which is true and useless.
 */
function waitingOn(status: string, leg: string): string {
  if (status === 'rejected') return 'This order was rejected, so nothing more happens to it.'
  if (status === 'cancelled') return 'This order was cancelled.'
  if (status === 'delivered') return 'The goods were received in full and stock was raised. This order is finished.'
  if (status === 'shipped') return 'The goods are on their way. Log the delivery on the depot order when they land.'
  if (status === 'fulfilling_from_stock') {
    return 'SRO are fulfilling this from their own stock, so no manufacturing order was raised.'
  }
  if (status === 'in_manufacturing') {
    return 'SRO chose to manufacture. The work is on the Bamida order above, which is where it can be sent and tracked.'
  }
  if (status === 'approved' && leg === 'DEPOT_TO_EB_GROUP') {
    return 'Approved and on its way. The next thing to happen here is logging the delivery when the goods land.'
  }
  if (status === 'approved' && leg === 'SRO_TO_CARGO') {
    return 'This is the transport leg. Its shipment shows below once Cargo Partner have a reference for it.'
  }
  return 'Nothing is waiting on this order here.'
}

