'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/admin'
import { shipmentInScope, transportScope } from '@/lib/cargo/scope.server'
import { trackShipment } from '@/lib/cargo/sync'
import { ensureHubShipmentForSpot, hubShipmentInScope } from '@/lib/transport/shipments.server'
import {
  SHIPMENT_DEPOTS,
  containerList,
  handShipmentDetailsSchema,
  lineRows,
  shipmentLinesSchema,
} from '@/lib/transport/shipment'

/**
 * Keeping a shipment by hand, and saying what is on any shipment.
 *
 * Dean, 24 Sep 2026: "Ideally all fields would need to be editable ... You must also be able to
 * edit shipments to be able to add what products are on the container."
 *
 * EVERY export of a 'use server' file is a callable endpoint, so each one checks transport.view
 * and the shipment's depot itself, and trusts nothing the page sent but ids and typed values. Like
 * the references, these write only the Hub's own records: nothing here reaches Cargo Partner but
 * the read that confirms a SPOT ID exists.
 */

type Result = { success: true; message: string } | { success: false; error: string }

const IdSchema = z.object({ id: z.string().uuid() })
const TargetSchema = z.union([
  z.object({ spotId: z.string().regex(/^[0-9]{6,12}$/) }),
  z.object({ id: z.string().uuid() }),
])

function refresh(key: string) {
  revalidatePath('/transport')
  revalidatePath(`/transport/${key}`)
}

export async function createHandShipment(
  input: unknown,
): Promise<{ success: true; id: string; message: string } | { success: false; error: string }> {
  const scope = await transportScope()
  if (!scope.ok) return { success: false, error: scope.error }
  const parsed = z.object({ depot: z.enum(SHIPMENT_DEPOTS) }).safeParse(input)
  if (!parsed.success) return { success: false, error: 'Choose the depot it is going to.' }
  const { depot } = parsed.data
  if (scope.depots && !scope.depots.includes(depot)) {
    return { success: false, error: 'You can only add shipments bound for your own depots.' }
  }

  const { data, error } = await createAdminClient()
    .from('transport_shipment')
    .insert({ destination_depot: depot, created_by: scope.uid, updated_by: scope.uid })
    .select('id')
    .single()
  if (error || !data) return { success: false, error: 'The shipment could not be added.' }
  revalidatePath('/transport')
  return { success: true, id: (data as { id: string }).id, message: 'Added. Fill in what you know; the rest can follow.' }
}

export async function updateHandShipment(input: unknown): Promise<Result> {
  const scope = await transportScope()
  if (!scope.ok) return { success: false, error: scope.error }
  const parsed = z.object({ id: z.string().uuid(), details: handShipmentDetailsSchema }).safeParse(input)
  if (!parsed.success) return { success: false, error: 'Something on the form is not valid. Check the dates.' }
  const { id, details } = parsed.data

  const found = await hubShipmentInScope(id, scope.depots)
  if (!found) return { success: false, error: 'No such shipment.' }
  if (found.spotId) return { success: false, error: 'Cargo Partner keeps the details of a booked shipment.' }
  // Moving it to another depot is a write on that depot too.
  if (scope.depots && !scope.depots.includes(details.depot)) {
    return { success: false, error: 'You can only send a shipment to one of your own depots.' }
  }
  const containers = containerList(details.containers)
  if (!containers.ok) {
    return { success: false, error: `${containers.bad} is not a container number. It is four letters and seven digits.` }
  }
  if (containers.numbers.length > 10) return { success: false, error: 'Ten containers is the most one shipment takes.' }

  const { error } = await createAdminClient()
    .from('transport_shipment')
    .update({
      destination_depot: details.depot,
      container_numbers: containers.numbers,
      shipper: details.shipper,
      booked_on: details.bookedOn,
      collected_on: details.collectedOn,
      shipped_on: details.shippedOn,
      eta_port: details.etaPort,
      eta_depot: details.etaDepot,
      delivered_on: details.deliveredOn,
      notes: details.notes,
      updated_by: scope.uid,
    })
    .eq('id', id)
    .is('spot_id', null)
  if (error) return { success: false, error: 'The details could not be saved.' }
  refresh(id)
  return { success: true, message: 'Saved.' }
}

export async function saveShipmentContents(input: unknown): Promise<Result> {
  const scope = await transportScope()
  if (!scope.ok) return { success: false, error: scope.error }
  const parsed = z.object({ target: TargetSchema, lines: shipmentLinesSchema }).safeParse(input)
  if (!parsed.success) {
    const issue = parsed.error.issues.find((i) => i.path[0] === 'lines')
    return { success: false, error: issue?.message ?? 'Something on the list is not valid.' }
  }
  const { target, lines } = parsed.data

  let shipmentId: string | null
  let key: string
  if ('spotId' in target) {
    if (!(await shipmentInScope(target.spotId, scope.depots))) return { success: false, error: 'No such shipment.' }
    shipmentId = await ensureHubShipmentForSpot(target.spotId, scope.uid)
    key = target.spotId
  } else {
    const found = await hubShipmentInScope(target.id, scope.depots)
    if (!found) return { success: false, error: 'No such shipment.' }
    shipmentId = found.id
    key = found.spotId ?? found.id
  }
  if (!shipmentId) return { success: false, error: 'The contents could not be saved.' }

  const { error } = await createAdminClient().rpc('transport_save_shipment_lines', {
    p_shipment_id: shipmentId,
    p_lines: lineRows(lines),
    p_user: scope.uid,
  })
  if (error) return { success: false, error: 'The contents could not be saved.' }
  refresh(key)
  return { success: true, message: lines.length ? 'Contents saved.' : 'Contents cleared.' }
}

/**
 * Once Cargo Partner has booked a shipment kept by hand, the SPOT ID joins it to the forwarder's
 * record. The same read "Add a shipment" makes confirms the SPOT ID exists; from then on the
 * shipment is tracked and refreshed like any other, and keeps what was typed on it.
 */
export async function linkShipmentToSpot(
  input: unknown,
): Promise<{ success: true; spotId: string; message: string } | { success: false; error: string }> {
  const scope = await transportScope()
  if (!scope.ok) return { success: false, error: scope.error }
  const parsed = z.object({ id: z.string().uuid(), value: z.string().trim().min(1).max(80) }).safeParse(input)
  if (!parsed.success) return { success: false, error: 'Type the SPOT ID, or a reference Cargo Partner knows it by.' }

  const found = await hubShipmentInScope(parsed.data.id, scope.depots)
  if (!found) return { success: false, error: 'No such shipment.' }
  if (found.spotId) return { success: false, error: `This shipment is already SPOT ${found.spotId}.` }

  const tracked = await trackShipment(parsed.data.value, scope.uid)
  if (!tracked.ok) return { success: false, error: tracked.error }
  const spots = [...tracked.added, ...tracked.alreadyOnBoard]
  if (spots.length !== 1) {
    return {
      success: false,
      error: `That matches ${spots.length} shipments (${spots.map((s) => `SPOT ${s}`).join(', ')}). Type the SPOT ID of this one.`,
    }
  }
  const spotId = spots[0]
  if (!(await shipmentInScope(spotId, scope.depots))) {
    return { success: false, error: `SPOT ${spotId} is bound for a depot outside your organisation.` }
  }

  const admin = createAdminClient()
  const { data: taken } = await admin.from('transport_shipment').select('id').eq('spot_id', spotId).maybeSingle()
  if (taken) {
    return { success: false, error: `SPOT ${spotId} already has its own record in the Hub. Add these contents there instead.` }
  }
  const { error } = await admin
    .from('transport_shipment')
    .update({ spot_id: spotId, updated_by: scope.uid })
    .eq('id', found.id)
    .is('spot_id', null)
  if (error) return { success: false, error: 'The SPOT ID could not be linked.' }
  refresh(found.id)
  refresh(spotId)
  return { success: true, spotId, message: `Linked to SPOT ${spotId}. Cargo Partner now tracks it.` }
}

export async function deleteHandShipment(input: unknown): Promise<Result> {
  const scope = await transportScope()
  if (!scope.ok) return { success: false, error: scope.error }
  const parsed = IdSchema.safeParse(input)
  if (!parsed.success) return { success: false, error: 'No such shipment.' }

  const found = await hubShipmentInScope(parsed.data.id, scope.depots)
  if (!found) return { success: false, error: 'No such shipment.' }
  if (found.spotId) return { success: false, error: 'A booked shipment stays; remove its contents instead.' }

  const { error } = await createAdminClient().from('transport_shipment').delete().eq('id', found.id).is('spot_id', null)
  if (error) return { success: false, error: 'The shipment could not be deleted.' }
  revalidatePath('/transport')
  return { success: true, message: 'Deleted.' }
}
