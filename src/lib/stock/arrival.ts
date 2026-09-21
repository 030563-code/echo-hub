import 'server-only'

/**
 * A container has arrived at a depot: the barriers leave s.r.o. and land on
 * that depot's shelf, in one press, by whoever is closing the shipment.
 *
 * Dean, 21 Sep 2026: "at the end of shipment juraj can select the depot of
 * arrival for that PO so it decrements SRO and increments the depot stock".
 *
 * The three ledger steps already existed one at a time: Bamida pressing
 * finished adds the barriers to EB-SRO, a Cargo Partner booking deducts them,
 * and the receiving warehouse logging a delivery line by line adds them to the
 * depot. In practice the middle one has never fired (po_shipments had no rows
 * for the first ten days) and the last one needs po.receive at the depot. So a
 * finished order stayed on the EB-SRO shelf for ever. This does the last two
 * steps together, keyed so that whichever of them already happened is skipped
 * rather than repeated.
 *
 * ORDER OF WRITES, and why. The ledger goes first, keyed on the chain rather
 * than on receipt rows, so a failure anywhere later leaves a retry that simply
 * applies the same movements again and is told they are already there. The
 * receipt rows come second as the audit trail and as the guard that stops a
 * line-by-line delivery being logged on top. Settlement is last and best
 * effort, like everywhere else in this ledger.
 *
 * What goes to the depot is what is still OUTSTANDING on the receiving leg,
 * so a partial delivery somebody logged the long way is not counted twice.
 * What leaves EB-SRO is the SRO leg in full, which is what a booking does.
 */

import type { createAdminClient } from '@/lib/supabase/admin'
import { applyStockMovements } from '@/lib/stock/apply'
import { buildArrivalMovements, buildShippedOutMovements } from '@/lib/stock/movements'
import { isArrivalDepot } from '@/lib/stock/warehouses'
import { settleDeliveredPO } from '@/lib/mrp/settle-po'

type Admin = ReturnType<typeof createAdminClient>

interface Leg {
  id: string
  leg: string
  status: string
  source: string
  master_ref: string | null
  from_entity: string | null
  lines: { id: string; sku: string | null; quantity: number | null }[] | null
}

export interface ArrivalInput {
  poId: string
  depot: string
  uid: string | null
  note?: string | null
  nowIso: string
}

export type ArrivalResult =
  | {
      ok: true
      depot: string
      /** Units added to the depot shelf. */
      units: number
      /** shipped_out rows the ledger applied, and how many it already held from a booking. */
      leftSro: { applied: number; skipped: number }
      receivingLegId: string
    }
  | { ok: false; error: string }

const LEG_SELECT = 'id, leg, status, source, master_ref, from_entity, lines:purchase_order_lines(id, sku, quantity)'

export async function arriveAtDepot(admin: Admin, input: ArrivalInput): Promise<ArrivalResult> {
  if (!isArrivalDepot(input.depot)) return { ok: false, error: 'That is not a depot a container can arrive at.' }

  // The leg we were handed, then the whole chain it belongs to.
  const { data: po } = await admin.from('purchase_orders').select(LEG_SELECT).eq('id', input.poId).maybeSingle<Leg>()
  if (!po) return { ok: false, error: 'Purchase order not found' }
  if (po.source !== 'hub') return { ok: false, error: 'Arrivals are only recorded against Hub-managed orders.' }

  let legs: Leg[] = [po]
  if (po.master_ref) {
    const { data } = await admin.from('purchase_orders').select(LEG_SELECT).eq('master_ref', po.master_ref)
    if (data && data.length > 0) legs = data as Leg[]
  }

  const sro = legs.find((l) => l.leg === 'EB_GROUP_TO_SRO')
  if (!sro) return { ok: false, error: 'This order has no s.r.o. leg, so nothing has left Kosice through the Hub.' }
  const depotLeg = legs.find((l) => l.leg === 'DEPOT_TO_EB_GROUP')
  // A refill raised by s.r.o. itself has no depot order above it; the goods
  // are still received somewhere, and the SRO leg is then the record.
  const receiving = depotLeg ?? sro
  if (receiving.status === 'delivered') return { ok: false, error: 'This order has already arrived.' }

  // The barriers must exist at s.r.o. before they can leave it, or EB-SRO goes
  // negative and stays there. Bamida pressing finished is that signal on the
  // manufacture branch; on the stock branch it is the s.r.o. order itself.
  const bamida = legs.find((l) => l.leg === 'SRO_TO_SUPPLIER')
  if (bamida) {
    const { data: mfg } = await admin
      .from('po_manufacturing')
      .select('finished_at')
      .eq('po_id', bamida.id)
      .maybeSingle<{ finished_at: string | null }>()
    if (!mfg?.finished_at) {
      return {
        ok: false,
        error: 'Bamida have not marked this order finished, so the Hub does not yet hold these barriers at s.r.o. to move.',
      }
    }
  } else if (!['ready_for_shipment', 'shipped'].includes(sro.status)) {
    return { ok: false, error: 'This order is not ready for shipment yet.' }
  }

  // What is still outstanding on the receiving leg.
  const lines = receiving.lines ?? []
  const { data: prior } = await admin.from('po_line_receipts').select('po_line_id, qty_received').eq('po_id', receiving.id)
  const received = new Map<string, number>()
  for (const r of prior ?? []) received.set(r.po_line_id, (received.get(r.po_line_id) ?? 0) + Number(r.qty_received))
  const outstanding = lines
    .map((l) => ({ ...l, remaining: Math.trunc(Number(l.quantity ?? 0)) - (received.get(l.id) ?? 0) }))
    .filter((l) => l.sku && l.remaining > 0)
  if (outstanding.length === 0) return { ok: false, error: 'Every line of this order has already been received.' }

  const note = (input.note ?? '').trim()
  const stamp = `Arrived at ${input.depot}${note ? ': ' + note : ''}`

  // 1. The ledger. Both halves in one call; each row is skipped by its own key
  //    if it is already there, so a booking that ran first is not doubled and
  //    a retry after a later failure is harmless.
  const rows = [
    ...buildShippedOutMovements(sro.id, sro.lines ?? [], stamp),
    ...buildArrivalMovements(receiving.id, input.depot, outstanding.map((l) => ({ sku: l.sku, quantity: l.remaining })), stamp),
  ]
  const ledger = await applyStockMovements(admin, rows, input.uid)
  if (!ledger.ok) return { ok: false, error: `The stock ledger refused the arrival: ${ledger.error}` }
  const leftSro = { applied: 0, skipped: 0 }
  // applyStockMovements reports totals, not per row; the shipped_out rows come
  // first, so a skip count at or above their number means the booking had them.
  const sroRows = buildShippedOutMovements(sro.id, sro.lines ?? [], stamp).length
  leftSro.skipped = Math.min(sroRows, ledger.skipped)
  leftSro.applied = sroRows - leftSro.skipped

  // 2. The receipt rows: the audit trail, and what stops a line-by-line
  //    delivery being logged on top of this one.
  const { error: rcErr } = await admin.from('po_line_receipts').insert(
    outstanding.map((l) => ({
      po_id: receiving.id,
      po_line_id: l.id,
      qty_received: l.remaining,
      batch_ref: `ARRIVAL ${input.depot}`,
      note: stamp,
      received_at: input.nowIso,
      received_by_uid: input.uid,
    })),
  )
  if (rcErr) console.error('arriveAtDepot receipt rows failed', receiving.id, rcErr.message)

  // 3. Settle: the receiving leg is delivered, in-transit rows drain, lead
  //    times are learned. The s.r.o. leg follows so the board stops calling
  //    barriers on a depot shelf "shipping".
  await settleDeliveredPO(admin, receiving.id, input.nowIso)
  if (receiving.id !== sro.id) {
    const { error: sroErr } = await admin
      .from('purchase_orders')
      .update({ status: 'delivered', delivered_at: input.nowIso })
      .eq('id', sro.id)
      .neq('status', 'delivered')
    if (sroErr) console.error('arriveAtDepot sro leg flip failed', sro.id, sroErr.message)
  }
  const chainIds = legs.map((l) => l.id)
  const { error: drainErr } = await admin
    .from('shipment_contents')
    .update({ status: 'delivered', delivered_at: input.nowIso })
    .in('po_id', chainIds)
    .neq('status', 'delivered')
  if (drainErr) console.error('arriveAtDepot in-transit drain failed', drainErr.message)

  return {
    ok: true,
    depot: input.depot,
    units: outstanding.reduce((a, l) => a + l.remaining, 0),
    leftSro,
    receivingLegId: receiving.id,
  }
}
