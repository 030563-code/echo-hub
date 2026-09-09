import 'server-only'

/**
 * Reading and drafting the shipment request row.
 *
 * Kept out of the 'use server' action file on purpose: every export of one of
 * those is a callable endpoint, and drafting a request is something the Hub does
 * to itself when Bamida finish an order, never something a browser may ask for.
 */

import { createAdminClient } from '@/lib/supabase/admin'
import { buildCargoDraft, type CargoDraft, type CargoLine, type PickupFrom } from '@/lib/cargo-request'
import { defaultCargoRecipients, resolveConsignee } from '@/app/actions/purchase-orders/notify-cargo-partner'

export type CargoRequestRow = {
  poId: string
  draft: CargoDraft
  updatedAt: string
  sentAt: string | null
  sentTo: string[]
  sentWasTest: boolean
}

export async function loadCargoRequest(poId: string): Promise<CargoRequestRow | null> {
  const { data } = await createAdminClient()
    .from('po_cargo_request')
    .select('po_id, request, updated_at, sent_at, sent_to, sent_was_test')
    .eq('po_id', poId)
    .maybeSingle()
  if (!data) return null
  return {
    poId: data.po_id as string,
    draft: data.request as CargoDraft,
    updatedAt: data.updated_at as string,
    sentAt: (data.sent_at as string | null) ?? null,
    sentTo: (data.sent_to as string[] | null) ?? [],
    sentWasTest: data.sent_was_test === true,
  }
}

/**
 * Draft the request when the barriers exist.
 *
 * Two callers, one shape: Bamida pressing "Manufacturing finished", and SRO
 * choosing to fulfil an order from stock. The only thing that differs is which
 * door the truck goes to, hence `pickupFrom`.
 *
 * Insert-if-absent, never an overwrite: a draft somebody has already corrected
 * must not be quietly reset by a second call. Both callers are one-shot anyway,
 * so this is a guard against a future one rather than against today's.
 */
export async function createCargoRequestDraft(input: {
  poId: string
  poNumber: string | null
  finishedAt: string
  lines: readonly CargoLine[]
  pickupFrom?: PickupFrom
}): Promise<CargoDraft> {
  const consignee = await resolveConsignee(input.poId)
  const { to, cc } = defaultCargoRecipients()
  const draft = buildCargoDraft({
    poNumber: input.poNumber,
    finishedAt: input.finishedAt,
    lines: input.lines,
    consignee,
    to,
    cc,
    pickupFrom: input.pickupFrom,
  })

  const { error } = await createAdminClient()
    .from('po_cargo_request')
    .upsert({ po_id: input.poId, request: draft }, { onConflict: 'po_id', ignoreDuplicates: true })
  if (error) console.error('createCargoRequestDraft failed', error.message)

  return draft
}
