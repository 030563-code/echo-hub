import type { FactoryStrings } from './strings'
import 'server-only'

/**
 * The three things that happen to a manufacturing order, and the fan-out that
 * hangs off the last of them.
 *
 * NOT a 'use server' file. These take the service-role client and a purchase
 * order id and write without a capability check of their own, because their
 * caller has already made one. Exported from a 'use server' module they would
 * each become a real server action addressable by anything that can guess an
 * action id, which is the IDOR shape the sales-hub audit found. Same reasoning
 * as quote-publish-tail.ts.
 *
 * Dean, 16 Sep 2026, on the order of the three: "They need to press confirm
 * purchase order and for the confirm button to work and for us to receive
 * confirmation they need to put in the estimated start and estimated finish
 * dates ... Then the next button is the manufacturing finished button which
 * they need to press upon invoicing otherwise we wont know if manufacturing is
 * finished to pay the invoice."
 */

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import type { createAdminClient } from '@/lib/supabase/admin'
import { applyStockMovements } from '@/lib/stock/apply'
import { buildManufacturedMovements } from '@/lib/stock/movements'
import type { SuppliedBomRow } from '@/lib/mrp/supplied-materials'
import { createCargoRequestDraft } from '@/lib/cargo-request-store'
import { notifyReadyForShipment } from '@/app/actions/purchase-orders/notify-ready-for-shipment'
import type { CargoLine } from '@/lib/cargo-request'

type Admin = ReturnType<typeof createAdminClient>

export type ManufacturingUpdateResult = { ok: true } | { ok: false; error: string }

export const DateInput = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-09-30')
  .nullable()

function revalidateOrder(poId: string) {
  revalidatePath('/factory')
  revalidatePath(`/factory/${poId}`)
  revalidatePath('/purchase-orders')
  revalidatePath(`/purchase-orders/${poId}`)
}

function datesOutOfOrder(estStart: string | null, estFinish: string | null): boolean {
  return Boolean(estStart && estFinish && estFinish < estStart)
}

/**
 * Estimated start and finish, changeable as often as they like until the order
 * is finished. Confirming is a separate act: this one only moves the dates.
 */
export async function applyManufacturingDates(
  admin: Admin,
  poId: string,
  dates: { estStart: string | null; estFinish: string | null },
  actorUid: string | null,
  /** The manufacturer's language, resolved by the action that called us. */
  t: FactoryStrings,
): Promise<ManufacturingUpdateResult> {
  if (datesOutOfOrder(dates.estStart, dates.estFinish)) {
    return { ok: false, error: t.errFinishBeforeStart }
  }

  const { data: updated, error } = await admin
    .from('po_manufacturing')
    .update({
      est_start: dates.estStart,
      est_finish: dates.estFinish,
      dates_updated_at: new Date().toISOString(),
      dates_updated_by_uid: actorUid,
    })
    .eq('po_id', poId)
    .is('finished_at', null)
    .select('po_id')
  if (error) {
    console.error('applyManufacturingDates failed', error.message)
    return { ok: false, error: t.errDatesNotSaved }
  }
  if (!updated || updated.length === 0) {
    return { ok: false, error: t.errAlreadyFinishedDates }
  }

  revalidateOrder(poId)
  return { ok: true }
}

/**
 * Confirm the purchase order.
 *
 * BOTH DATES ARE REQUIRED, and that is the whole point of the step. Dean: the
 * confirm button works only when they are filled in, because the confirmation
 * we receive, and the email they get back, are the dates. A confirmation with
 * nothing in it would tell us they have seen the order and nothing else.
 *
 * ONE SHOT, like the finish: confirmed_at moves off null in a single
 * conditional update, so a double press or a retry confirms once and emails
 * once.
 */
export async function confirmManufacturingOrder(
  admin: Admin,
  poId: string,
  dates: { estStart: string | null; estFinish: string | null },
  actorUid: string | null,
  t: FactoryStrings,
): Promise<ManufacturingUpdateResult & { confirmedAt?: string }> {
  if (!dates.estStart || !dates.estFinish) {
    return { ok: false, error: t.errBothDatesRequired }
  }
  if (datesOutOfOrder(dates.estStart, dates.estFinish)) {
    return { ok: false, error: t.errFinishBeforeStart }
  }

  const confirmedAt = new Date().toISOString()
  const { data: confirmed, error } = await admin
    .from('po_manufacturing')
    .update({
      confirmed_at: confirmedAt,
      confirmed_by_uid: actorUid,
      est_start: dates.estStart,
      est_finish: dates.estFinish,
      dates_updated_at: confirmedAt,
      dates_updated_by_uid: actorUid,
    })
    .eq('po_id', poId)
    .is('confirmed_at', null)
    .is('finished_at', null)
    .select('po_id')
  if (error) {
    console.error('confirmManufacturingOrder failed', error.message)
    return { ok: false, error: t.errConfirmationNotSaved }
  }
  if (!confirmed || confirmed.length === 0) {
    return { ok: false, error: t.errAlreadyConfirmed }
  }

  revalidateOrder(poId)
  return { ok: true, confirmedAt }
}

/**
 * Manufacturing finished.
 *
 * ONE SHOT. finished_at moves off null in a single conditional update, so a
 * double press, a retry or a refresh cannot stamp it twice. This timestamp is
 * what the Cargo Partner shipment request is hung on, and that request is what
 * asks a freight forwarder to move a container, which is exactly why this may
 * only ever happen once. It is also what lets us pay their invoice.
 *
 * Refused before the order is confirmed: the two steps are a sequence, and a
 * finish with no confirmation would leave us with no dates and no acceptance.
 */
export async function finishManufacturingOrder(
  admin: Admin,
  poId: string,
  actorUid: string | null,
  t: FactoryStrings,
): Promise<ManufacturingUpdateResult> {
  const finishedAtIso = new Date().toISOString()
  const { data: finished, error } = await admin
    .from('po_manufacturing')
    .update({ finished_at: finishedAtIso, finished_by_uid: actorUid })
    .eq('po_id', poId)
    .not('confirmed_at', 'is', null)
    .is('finished_at', null)
    .select('po_id')
  if (error) {
    console.error('finishManufacturingOrder failed', error.message)
    return { ok: false, error: t.errNotSaved }
  }
  if (!finished || finished.length === 0) {
    // Two ways to get no row, and they need different words.
    const { data: row } = await admin
      .from('po_manufacturing')
      .select('confirmed_at, finished_at')
      .eq('po_id', poId)
      .maybeSingle<{ confirmed_at: string | null; finished_at: string | null }>()
    if (row && !row.confirmed_at) {
      return { ok: false, error: t.errConfirmFirst }
    }
    return { ok: false, error: t.errAlreadyFinished }
  }

  // NO lifecycle_stage write. Dean, 9 Sep: a finished order is "Ready for
  // shipment", and only a confirmed Cargo Partner SPOT id makes it "Shipping".
  // `deriveStage` reads finished_at and says exactly that on its own, and a
  // PERSISTED stage outranks derivation, so stamping one here would freeze the
  // card and stop the SPOT id ever moving it on.
  //
  // What DOES need writing is the parent. The SRO leg sat on `in_manufacturing`
  // for ever after the factory finished, so its badge said Manufacturing about
  // barriers already on a pallet.
  //
  // Compare-and-set on in_manufacturing: an SRO leg somebody has already moved
  // on is left alone rather than dragged backwards.
  const { data: manufacturingPo } = await admin
    .from('purchase_orders')
    .select('parent_po_id')
    .eq('id', poId)
    .maybeSingle<{ parent_po_id: string | null }>()
  if (manufacturingPo?.parent_po_id) {
    const { error: parentErr } = await admin
      .from('purchase_orders')
      .update({ status: 'ready_for_shipment' })
      .eq('id', manufacturingPo.parent_po_id)
      .eq('status', 'in_manufacturing')
    if (parentErr) console.error('finishManufacturingOrder parent status failed', parentErr.message)
  }

  // THE LEDGER. Dean, 9 Sep 2026 (D2): the barriers now exist at s.r.o., so
  // they are added to EB-SRO on hand (committed to this order until it is
  // booked), and the s.r.o.-owned materials they were built from are gone,
  // estimated from the supplied-components bill of materials because no row of
  // it is verified yet. The one-shot claim above already guarantees this runs
  // once per order; the ledger's own key is the backstop. Best effort, like
  // everything after the timestamp.
  {
    const { data: builtLines } = await admin
      .from('purchase_order_lines')
      .select('sku, quantity')
      .eq('po_id', poId)
    const skus = Array.from(new Set((builtLines ?? []).map((l) => String(l.sku ?? '')).filter(Boolean)))
    const { data: bomRows } = skus.length
      ? await admin
          .from('mrp_bom_map')
          .select('finished_sku, component_code, component_desc, qty_per')
          .in('finished_sku', skus)
      : { data: [] as SuppliedBomRow[] }
    const ledger = await applyStockMovements(
      admin,
      buildManufacturedMovements(poId, builtLines ?? [], (bomRows ?? []) as SuppliedBomRow[]),
      null,
    )
    if (!ledger.ok) console.error('finishManufacturingOrder stock ledger failed', poId, ledger.error)
  }

  // Barriers ready to collect, so DRAFT the shipment request. It is not sent
  // here and the factory never see it: they are telling us the barriers exist,
  // which is not the same as a decision to book freight. Somebody at Echo
  // Barrier reads the request, fixes what is wrong (the Incoterm, above all)
  // and releases it from the purchase order screen.
  //
  // Best effort, and after the timestamp is safely written: they have finished
  // the order either way, and a failure here must never leave them pressing a
  // button that says it did not work.
  const { data: po } = await admin
    .from('purchase_orders')
    .select('po_number, master_ref, lines:purchase_order_lines(product_name, product_family, quantity)')
    .eq('id', poId)
    .maybeSingle<{ po_number: string | null; master_ref: string | null; lines: CargoLine[] | null }>()
  const draft = await createCargoRequestDraft({
    poId,
    poNumber: po?.po_number ?? null,
    finishedAt: finishedAtIso,
    lines: po?.lines ?? [],
  })

  // And tell us, because a queue nobody is told about is a queue nobody works.
  // Dean, 9 Sep: the manufacturer pressing finished should email Juraj in
  // production, the test address while testing, saying the order is ready for
  // shipment. Built from the draft above, so the email and the approval screen
  // cannot show different figures.
  const told = await notifyReadyForShipment(
    { poId, poNumber: po?.po_number ?? null, masterRef: po?.master_ref ?? null },
    draft,
  )
  if (!told.sent && told.reason === 'failed') {
    console.error('finishManufacturingOrder ready notify failed', poId)
  }

  revalidateOrder(poId)
  return { ok: true }
}
