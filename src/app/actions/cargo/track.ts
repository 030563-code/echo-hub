'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/admin'
import { shipmentInScope, transportScope } from '@/lib/cargo/scope.server'
import { trackShipment } from '@/lib/cargo/sync'
import { cleanReference } from '@/lib/cargo/references'

/**
 * Adding to the board by hand, and keeping our own references on a shipment.
 *
 * Dean, 23 Sep 2026: "theres no way to manually add spot ids or shipments or references?"
 *
 * Gated on transport.view like Refresh: these write only to the Hub's own copy, never to Cargo
 * Partner. A reference is added or removed only on a shipment bound for one of the caller's own
 * depots (or any, for s.r.o. and Group), checked here and not trusted from the page.
 */

type Result = { success: true; message: string } | { success: false; error: string }

const AddSchema = z.object({ value: z.string().trim().min(1).max(80) })
const ReferenceSchema = z.object({
  spotId: z.string().trim().regex(/^[0-9]{6,12}$/),
  reference: z.string().max(200),
})
const RemoveSchema = z.object({ id: z.string().uuid() })

const listOf = (ids: string[]) => ids.map((id) => `SPOT ${id}`).join(', ')

export async function addShipment(input: unknown): Promise<Result> {
  const scope = await transportScope()
  if (!scope.ok) return { success: false, error: scope.error }
  const parsed = AddSchema.safeParse(input)
  if (!parsed.success) return { success: false, error: 'Type a SPOT ID or a reference, up to 80 characters.' }

  const result = await trackShipment(parsed.data.value, scope.uid)
  if (!result.ok) return { success: false, error: result.error }
  revalidatePath('/transport')

  const parts: string[] = []
  if (result.added.length) parts.push(`Added ${listOf(result.added)}.`)
  if (result.alreadyOnBoard.length) parts.push(`${listOf(result.alreadyOnBoard)} was already on the board, and is refreshed.`)
  // Added, but bound for somebody else's depot: say so rather than let it seem to vanish.
  const hidden: string[] = []
  for (const id of result.added) if (!(await shipmentInScope(id, scope.depots))) hidden.push(id)
  if (hidden.length) parts.push(`${listOf(hidden)} is bound for a depot outside your organisation, so it shows under that organisation.`)
  return { success: true, message: parts.join(' ') }
}

export async function addShipmentReference(input: unknown): Promise<Result> {
  const scope = await transportScope()
  if (!scope.ok) return { success: false, error: scope.error }
  const parsed = ReferenceSchema.safeParse(input)
  const reference = parsed.success ? cleanReference(parsed.data.reference) : null
  if (!parsed.success || !reference) return { success: false, error: 'A reference is 1 to 80 characters.' }
  if (!(await shipmentInScope(parsed.data.spotId, scope.depots))) return { success: false, error: 'No such shipment.' }

  const { error } = await createAdminClient()
    .from('cargo_shipment_reference')
    .insert({ spot_id: parsed.data.spotId, reference, added_by: scope.uid })
  if (error) {
    if (error.code === '23505') return { success: false, error: `${reference} is already on this shipment.` }
    return { success: false, error: 'The reference could not be saved.' }
  }
  revalidatePath('/transport')
  revalidatePath(`/transport/${parsed.data.spotId}`)
  return { success: true, message: `Added ${reference}.` }
}

export async function removeShipmentReference(input: unknown): Promise<Result> {
  const scope = await transportScope()
  if (!scope.ok) return { success: false, error: scope.error }
  const parsed = RemoveSchema.safeParse(input)
  if (!parsed.success) return { success: false, error: 'No such reference.' }

  const admin = createAdminClient()
  const { data: row } = await admin
    .from('cargo_shipment_reference')
    .select('spot_id, reference')
    .eq('id', parsed.data.id)
    .maybeSingle()
  const found = row as { spot_id: string; reference: string } | null
  if (!found || !(await shipmentInScope(found.spot_id, scope.depots))) return { success: false, error: 'No such reference.' }

  const { error } = await admin.from('cargo_shipment_reference').delete().eq('id', parsed.data.id)
  if (error) return { success: false, error: 'The reference could not be removed.' }
  revalidatePath('/transport')
  revalidatePath(`/transport/${found.spot_id}`)
  return { success: true, message: `Removed ${found.reference}.` }
}
