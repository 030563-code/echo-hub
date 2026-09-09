import 'server-only'

/**
 * One purchase order, hydrated the way the board hydrates all of them.
 *
 * The email that tells SRO an order has arrived links to the single order page,
 * so whoever follows that link must not find a thinner order there than the
 * board drawer shows: no receipts, no files, no shipment, no manufacturing
 * progress.
 *
 * This is deliberately NOT shared with the board. The board hydrates every open
 * order in five bulk queries; calling this once per order would be that many
 * round trips per row. The selects are kept identical to the board's on purpose,
 * and the board page says the same thing in the other direction.
 */

import { createServerClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { stripPurchaseOrderCosts } from '@/lib/price-visibility'
import { getPoPdfData, type PoPdfData } from '@/lib/po-pdf-data'
import type { PurchaseOrder, PoAttachment, PoShipment } from '@/lib/erp-types'

/**
 * A sibling leg of the same order: enough to link to it, label it, and find the
 * root of the chain. The root matters because the cost is entered on the depot
 * leg in that depot's currency and the PDF converts from there, so a page that
 * cannot find the root would print converted prices at the wrong rate.
 */
export type PoChainLeg = {
  id: string
  po_number: string | null
  leg: string
  status: string
  parent_po_id: string | null
  from_entity: string
}

/**
 * What Bamida have said, in the shape the manufacturing card takes.
 *
 * Kept OFF `po.manufacturing` because `sent_to` is a recipient list and
 * PurchaseOrder is handed whole to client components elsewhere. This one is
 * loaded for one order and passed to one card, deliberately.
 */
export type ManufacturingProgress = {
  sentAt: string | null
  sentTo: string[]
  sentWasTest: boolean
  estStart: string | null
  estFinish: string | null
  finishedAt: string | null
}

export type PurchaseOrderDetail = {
  po: PurchaseOrder
  chain: PoChainLeg[]
  pdf: PoPdfData
  /** Null on any leg that is not a Bamida order, or one never sent. */
  manufacturing: ManufacturingProgress | null
}

/** Null when the order does not exist, so the caller can notFound(). */
export async function loadPurchaseOrderDetail(
  id: string,
  canViewCost: boolean
): Promise<PurchaseOrderDetail | null> {
  const supabase = await createServerClient()

  const { data: order } = await supabase
    .from('purchase_orders')
    .select('*, lines:purchase_order_lines(*)')
    .eq('id', id)
    .maybeSingle<PurchaseOrder>()
  if (!order) return null

  // This is the security point of the module. unit_price is nulled server-side
  // before the order leaves here, so a viewer without cost.view cannot receive
  // it in an RSC payload even when the screen renders no price column.
  const [po] = stripPurchaseOrderCosts([order], canViewCost)

  // Received totals per line (partial-delivery progress).
  const lineIds = (po.lines ?? []).map((l) => l.id)
  if (lineIds.length) {
    const { data: receipts } = await supabase
      .from('po_line_receipts')
      .select('po_line_id, qty_received')
      .in('po_line_id', lineIds)
    const recvByLine = new Map<string, number>()
    for (const r of receipts ?? []) recvByLine.set(r.po_line_id, (recvByLine.get(r.po_line_id) ?? 0) + r.qty_received)
    for (const l of po.lines ?? []) l.qty_received = recvByLine.get(l.id) ?? 0
  }

  // Files attached to this PO.
  const { data: atts } = await supabase
    .from('po_attachments')
    .select('id, po_id, storage_path, filename, content_type, size_bytes, uploaded_by_uid, created_at')
    .eq('po_id', po.id)
    .order('created_at', { ascending: false })
  po.attachments = (atts ?? []) as PoAttachment[]

  // The auto-resolved Cargo Partner shipment (SPOT ID + tracking).
  const { data: ship } = await supabase.from('po_shipments').select('*').eq('po_id', po.id).maybeSingle()
  po.shipment = (ship as PoShipment | null) ?? null

  // Manufacturing progress: sent, dates given, finished. Read with the
  // service-role client because po_manufacturing is not reachable by anon or
  // authenticated at all, and narrowed to the presentational columns.
  const { data: mfg } = await createAdminClient()
    .from('po_manufacturing')
    .select('po_id, sent_at, sent_to, sent_was_test, est_start, est_finish, finished_at')
    .eq('po_id', po.id)
    .maybeSingle()
  // The board's four presentational columns hang off the order, exactly as they
  // do on the board. The recipients do not: they travel separately below.
  po.manufacturing = mfg
    ? {
        sent_at: mfg.sent_at ?? null,
        sent_was_test: mfg.sent_was_test === true,
        est_start: mfg.est_start ?? null,
        est_finish: mfg.est_finish ?? null,
        finished_at: mfg.finished_at ?? null,
      }
    : null

  const manufacturing: ManufacturingProgress | null = mfg
    ? {
        sentAt: mfg.sent_at ?? null,
        sentTo: (mfg.sent_to as string[] | null) ?? [],
        sentWasTest: mfg.sent_was_test === true,
        estStart: mfg.est_start ?? null,
        estFinish: mfg.est_finish ?? null,
        finishedAt: mfg.finished_at ?? null,
      }
    : null

  // The other legs of the same order, oldest first. An order with no master_ref
  // is its own chain, so the caller never has to special-case an empty list.
  let chain: PoChainLeg[] = [
    {
      id: po.id,
      po_number: po.po_number,
      leg: po.leg,
      status: po.status,
      parent_po_id: po.parent_po_id,
      from_entity: po.from_entity,
    },
  ]
  if (po.master_ref) {
    const { data: legs } = await supabase
      .from('purchase_orders')
      .select('id, po_number, leg, status, parent_po_id, from_entity')
      .eq('master_ref', po.master_ref)
      .order('created_at', { ascending: true })
    if (legs?.length) chain = legs as PoChainLeg[]
  }

  // From/To party addresses + weekly FX for the branded PO PDF.
  const pdf = await getPoPdfData(supabase)

  return { po, chain, pdf, manufacturing }
}
