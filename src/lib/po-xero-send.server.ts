import 'server-only'

/**
 * Reading the Hub's record of hand-offs to Xero, for the pages that show it.
 *
 * public.po_xero_sends is closed to everyone but the service role, so it is read here and only
 * the words a screen needs travel on. The rules themselves live in src/lib/po-xero-send.ts; this
 * file adds the database and the clock, and the clock is read in these functions rather than in
 * a component, so nothing works out the time while it renders.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { createAdminClient } from '@/lib/supabase/admin'
import {
  XERO_LEGS,
  XERO_SEND_COLUMNS,
  xeroSendView,
  type XeroSendFailure,
  type XeroSendLeg,
  type XeroSendRecord,
} from '@/lib/po-xero-send'
import type { PurchaseOrder } from '@/lib/erp-types'

/** The Hub's records for these legs. */
export async function loadXeroSendRecords(poIds: readonly string[]): Promise<XeroSendRecord[]> {
  if (poIds.length === 0) return []
  const { data } = await createAdminClient().from('po_xero_sends').select(XERO_SEND_COLUMNS).in('po_id', [...poIds])
  return (data ?? []) as XeroSendRecord[]
}

/** Hang each order's hand-off state on it, for pages that pass orders to the browser whole. */
export function withXeroSendViews(orders: PurchaseOrder[], records: readonly XeroSendRecord[], nowMs = Date.now()): void {
  const byPo = new Map(records.map((r) => [r.po_id, r]))
  for (const order of orders) order.xero_send = xeroSendView(order, byPo.get(order.id), nowMs)
}

type FailureCandidate = XeroSendLeg & { id: string; po_number: string }

/**
 * The approved Depot and Group legs in these chains whose send to Xero has failed.
 *
 * `filter` is the organisation's chain filter (chainFilter in src/lib/po-organisations.ts), null
 * when it holds no chains. It goes into the query, so another organisation's orders are never
 * read. A Xero id that is null or blank counts as missing, the same rule the order page applies,
 * which is why there are two reads rather than one.
 */
export async function loadXeroSendFailures(
  supabase: SupabaseClient,
  filter: string | null,
  nowMs = Date.now(),
): Promise<XeroSendFailure[]> {
  if (filter === null) return []
  const approvedXeroLegs = () =>
    supabase
      .from('purchase_orders')
      .select('id, po_number, leg, status, source, approved_at, xero_po_id')
      .or(filter)
      .eq('source', 'hub')
      .in('leg', [...XERO_LEGS])
      .not('approved_at', 'is', null)
  const [noId, blankId] = await Promise.all([
    approvedXeroLegs().is('xero_po_id', null),
    approvedXeroLegs().eq('xero_po_id', ''),
  ])
  const legs = [...(noId.data ?? []), ...(blankId.data ?? [])] as FailureCandidate[]
  if (legs.length === 0) return []

  const byPo = new Map((await loadXeroSendRecords(legs.map((l) => l.id))).map((r) => [r.po_id, r]))
  const found: { failure: XeroSendFailure; approvedAt: string }[] = []
  for (const leg of legs) {
    const view = xeroSendView(leg, byPo.get(leg.id), nowMs)
    if (view?.kind !== 'failed') continue
    found.push({
      failure: { id: leg.id, po_number: leg.po_number, leg: leg.leg, message: view.message },
      approvedAt: String(leg.approved_at),
    })
  }
  // Newest approval first: the one somebody is most likely to be asking about.
  found.sort((a, b) => b.approvedAt.localeCompare(a.approvedAt))
  return found.map((f) => f.failure)
}
