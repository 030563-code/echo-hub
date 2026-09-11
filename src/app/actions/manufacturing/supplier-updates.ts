'use server'

/**
 * The two things Bamida may do, and nothing else.
 *
 * Every export of a 'use server' file is a callable endpoint, so each of these
 * has to stand on its own with no session behind it. The token IS the
 * authorisation: it names one purchase order, it is resolved server-side on
 * every call, and neither action takes a purchase order id from the caller.
 * Handing over a po_id would let anybody with one valid link write to any order
 * in the system.
 */

import { z } from 'zod'
import { revalidatePath } from 'next/cache'
import { createAdminClient } from '@/lib/supabase/admin'
import { resolveManufacturingToken } from '@/lib/manufacturing-token'
import { applyStockMovements } from '@/lib/stock/apply'
import { buildManufacturedMovements } from '@/lib/stock/movements'
import type { SuppliedBomRow } from '@/lib/mrp/supplied-materials'
import { createCargoRequestDraft } from '@/lib/cargo-request-store'
import { notifyReadyForShipment } from '@/app/actions/purchase-orders/notify-ready-for-shipment'
import type { CargoLine } from '@/lib/cargo-request'

const DateInput = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-09-30')
  .nullable()

const DatesSchema = z.object({
  token: z.string().min(1).max(200),
  estStart: DateInput,
  estFinish: DateInput,
})

const FinishSchema = z.object({ token: z.string().min(1).max(200) })

export type SupplierUpdateResult = { ok: true } | { ok: false; error: string }

const REFUSED: Record<'unknown' | 'expired' | 'revoked', string> = {
  unknown: 'This link is not valid. Ask Echo Barrier for a new one.',
  expired: 'This link has expired. Ask Echo Barrier for a new one.',
  revoked: 'This link has been withdrawn. Ask Echo Barrier for a new one.',
}

/** Estimated start and finish. Editable as often as they like, until finished. */
export async function saveManufacturingDates(input: {
  token: string
  estStart: string | null
  estFinish: string | null
}): Promise<SupplierUpdateResult> {
  const parsed = DatesSchema.safeParse(input)
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid dates' }

  const { estStart, estFinish } = parsed.data
  if (estStart && estFinish && estFinish < estStart) {
    return { ok: false, error: 'The finish date cannot be before the start date.' }
  }

  const resolved = await resolveManufacturingToken(parsed.data.token)
  if (!resolved.ok) return { ok: false, error: REFUSED[resolved.reason] }

  const { data: updated, error } = await createAdminClient()
    .from('po_manufacturing')
    .update({
      est_start: estStart,
      est_finish: estFinish,
      dates_updated_at: new Date().toISOString(),
    })
    .eq('po_id', resolved.poId)
    .is('finished_at', null)
    .select('po_id')
  if (error) {
    console.error('saveManufacturingDates failed', error.message)
    return { ok: false, error: 'The dates could not be saved. Please try again.' }
  }
  if (!updated || updated.length === 0) {
    return { ok: false, error: 'This order is already marked finished, so its dates can no longer change.' }
  }

  revalidatePath(`/purchase-orders/${resolved.poId}`)
  return { ok: true }
}

/**
 * Manufacturing finished.
 *
 * ONE SHOT. finished_at moves off null in a single conditional update, so a
 * double press, a retry or a refresh cannot stamp it twice. This timestamp is
 * what the Cargo Partner shipment request is hung on, and that request is what
 * asks a freight forwarder to move a container, which is exactly why this may
 * only ever happen once.
 */
export async function markManufacturingFinished(input: { token: string }): Promise<SupplierUpdateResult> {
  const parsed = FinishSchema.safeParse(input)
  if (!parsed.success) return { ok: false, error: 'Invalid link' }

  const resolved = await resolveManufacturingToken(parsed.data.token)
  if (!resolved.ok) return { ok: false, error: REFUSED[resolved.reason] }

  const admin = createAdminClient()
  const finishedAtIso = new Date().toISOString()
  const { data: finished, error } = await admin
    .from('po_manufacturing')
    .update({ finished_at: finishedAtIso })
    .eq('po_id', resolved.poId)
    .is('finished_at', null)
    .select('po_id')
  if (error) {
    console.error('markManufacturingFinished failed', error.message)
    return { ok: false, error: 'That could not be saved. Please try again.' }
  }
  if (!finished || finished.length === 0) {
    return { ok: false, error: 'This order is already marked finished.' }
  }

  // NO lifecycle_stage write. Dean, 9 Sep: a finished order is "Ready for
  // shipment", and only a confirmed Cargo Partner SPOT id makes it "Shipping".
  // `deriveStage` reads finished_at and says exactly that on its own, and a
  // PERSISTED stage outranks derivation, so stamping one here would freeze the
  // card and stop the SPOT id ever moving it on. The old code wrote 'shipping'
  // straight past the ready state, which is the bug Dean saw.
  //
  // What DOES need writing is the parent. The SRO leg sat on `in_manufacturing`
  // for ever after Bamida finished, so its badge said Manufacturing about
  // barriers already on a pallet. That is the other half of what he reported.
  //
  // Compare-and-set on in_manufacturing: an SRO leg somebody has already moved
  // on is left alone rather than dragged backwards.
  const { data: bamidaPo } = await admin
    .from('purchase_orders')
    .select('parent_po_id')
    .eq('id', resolved.poId)
    .maybeSingle<{ parent_po_id: string | null }>()
  if (bamidaPo?.parent_po_id) {
    const { error: parentErr } = await admin
      .from('purchase_orders')
      .update({ status: 'ready_for_shipment' })
      .eq('id', bamidaPo.parent_po_id)
      .eq('status', 'in_manufacturing')
    if (parentErr) console.error('markManufacturingFinished parent status failed', parentErr.message)
  }

  // THE LEDGER. Dean, 9 Sep 2026 (D2): the barriers now exist at s.r.o., so
  // they are added to EB-SRO on hand (committed to this order until it is
  // booked), and the s.r.o.-owned materials they were built from are gone,
  // estimated from the supplied-components bill of materials because no row
  // of it is verified yet. The one-shot claim above already guarantees this
  // runs once per order; the ledger's own key is the backstop. Best effort,
  // like everything after the timestamp.
  {
    const { data: builtLines } = await admin
      .from('purchase_order_lines')
      .select('sku, quantity')
      .eq('po_id', resolved.poId)
    const skus = Array.from(new Set((builtLines ?? []).map((l) => String(l.sku ?? '')).filter(Boolean)))
    const { data: bomRows } = skus.length
      ? await admin
          .from('mrp_bom_map')
          .select('finished_sku, component_code, component_desc, qty_per')
          .in('finished_sku', skus)
      : { data: [] as SuppliedBomRow[] }
    const ledger = await applyStockMovements(
      admin,
      buildManufacturedMovements(resolved.poId, builtLines ?? [], (bomRows ?? []) as SuppliedBomRow[]),
      null,
    )
    if (!ledger.ok) console.error('markManufacturingFinished stock ledger failed', resolved.poId, ledger.error)
  }

  // Barriers ready to collect, so DRAFT the shipment request. It is not sent
  // here and Bamida never see it: they are a factory telling us the barriers
  // exist, which is not the same as a decision to book freight. Somebody at
  // Echo Barrier reads the request, fixes what is wrong (the Incoterm, above
  // all) and releases it from the purchase order screen.
  //
  // Best effort, and after the timestamp is safely written: Bamida have
  // finished the order either way, and a failure here must never leave them
  // pressing a button that says it did not work.
  const { data: po } = await admin
    .from('purchase_orders')
    .select('po_number, master_ref, lines:purchase_order_lines(product_name, product_family, quantity)')
    .eq('id', resolved.poId)
    .maybeSingle<{ po_number: string | null; master_ref: string | null; lines: CargoLine[] | null }>()
  const draft = await createCargoRequestDraft({
    poId: resolved.poId,
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
    { poId: resolved.poId, poNumber: po?.po_number ?? null, masterRef: po?.master_ref ?? null },
    draft,
  )
  if (!told.sent && told.reason === 'failed') {
    console.error('markManufacturingFinished ready notify failed', resolved.poId)
  }

  revalidatePath(`/purchase-orders/${resolved.poId}`)
  revalidatePath('/purchase-orders')
  return { ok: true }
}
