import 'server-only'

/**
 * Reading and drafting the shipment request row.
 *
 * Kept out of the 'use server' action file on purpose: every export of one of
 * those is a callable endpoint, and drafting a request is something the Hub does
 * to itself when Bamida finish an order, never something a browser may ask for.
 */

import { createAdminClient } from '@/lib/supabase/admin'
import { buildCargoDraft, PICKUP_FROM, type CargoDraft, type CargoLine, type PickupFrom } from '@/lib/cargo-request'
import { defaultCargoRecipients, resolveConsignee } from '@/app/actions/purchase-orders/notify-cargo-partner'

export type CargoRequestRow = {
  poId: string
  draft: CargoDraft
  updatedAt: string
  sentAt: string | null
  sentTo: string[]
  sentWasTest: boolean
}

/**
 * A stored draft, made whole.
 *
 * `request` is jsonb, so a row written before a field existed simply does not
 * have it, and the type assertion on the way out says otherwise. That is not
 * theoretical: `pickup_from` was added on 9 Sep 2026 and every draft written
 * before it went straight to a component that read
 * `PICKUP_PARTIES[draft.pickup_from].name` and took the whole purchase order
 * page down with it.
 *
 * So the shape is completed HERE, at the one boundary where untyped storage
 * becomes a typed object, rather than defended at each of the places that read
 * it. BAMIDA is the right default and not a guess: until that same day, the only
 * thing that could create a draft at all was Bamida pressing finished. A save or
 * a send re-pins it from the order's own fulfilment type anyway.
 */
function hydrateDraft(raw: unknown): CargoDraft {
  const draft = (raw ?? {}) as CargoDraft
  const pickup = (PICKUP_FROM as readonly string[]).includes(draft.pickup_from)
    ? draft.pickup_from
    : 'BAMIDA'
  return { ...draft, pickup_from: pickup }
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
    draft: hydrateDraft(data.request),
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
