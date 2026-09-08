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
 * what the Cargo Partner transport order will later be hung on, and a transport
 * order is a real booking with a freight forwarder, which is exactly why this
 * may only ever happen once.
 */
export async function markManufacturingFinished(input: { token: string }): Promise<SupplierUpdateResult> {
  const parsed = FinishSchema.safeParse(input)
  if (!parsed.success) return { ok: false, error: 'Invalid link' }

  const resolved = await resolveManufacturingToken(parsed.data.token)
  if (!resolved.ok) return { ok: false, error: REFUSED[resolved.reason] }

  const admin = createAdminClient()
  const { data: finished, error } = await admin
    .from('po_manufacturing')
    .update({ finished_at: new Date().toISOString() })
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

  // The board should show it as ready to ship. Presentation only: the status
  // machine is untouched, exactly as the lifecycle_stage design intends.
  const { error: stageErr } = await admin
    .from('purchase_orders')
    .update({ lifecycle_stage: 'shipping' })
    .eq('id', resolved.poId)
  if (stageErr) console.error('markManufacturingFinished stage failed', stageErr.message)

  revalidatePath(`/purchase-orders/${resolved.poId}`)
  revalidatePath('/purchase-orders')
  return { ok: true }
}
