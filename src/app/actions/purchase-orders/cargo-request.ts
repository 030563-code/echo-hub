'use server'

/**
 * Review a shipment request, then release it to Cargo Partner.
 *
 * Dean, 9 Sep 2026: there has to be an approval step before anything reaches the
 * forwarder, showing what is about to go out with the fields editable.
 *
 * Two reasons this is not decoration. Bamida press "Manufacturing finished" and
 * Bamida are a factory: that press says the barriers exist, it is not a decision
 * to book freight. And the request carries the one field nobody has ever
 * answered, the Incoterm, which decides who pays for the leg. A person reads it,
 * fixes it, releases it.
 *
 * RELEASING IS CLAIMED, NOT LABELLED. The edit and the claim are ONE conditional
 * update: sent_at moves off null exactly once, so two clicks, a retry or a
 * refresh cannot ask a forwarder twice for the same container. If the send then
 * fails, the claim is handed back, because nothing left the building.
 *
 * It EMAILS. It writes nothing to the Cargo Partner API, by standing
 * instruction, on production or on test.
 */

import { z } from 'zod'
import { revalidatePath } from 'next/cache'
import { createAdminClient } from '@/lib/supabase/admin'
import { getAuthorizedUser } from '@/lib/authz'
import { sendDescription } from '@/lib/email-recipients'
import { INCOTERMS, MODALITIES, CATEGORIES, DIRECTIONS, PACKAGE_TYPES, PICKUP_FROM } from '@/lib/cargo-request'
import { notifyCargoPartnerReady } from '@/app/actions/purchase-orders/notify-cargo-partner'

/** No SKU: our database codes do not go to a forwarder. Zod drops a stored one. */
const Line = z.object({
  product_name: z.string().max(200).nullable(),
  product_family: z.string().max(64).nullable(),
  quantity: z.number().int().min(0).nullable(),
  pallets: z.number().int().min(0),
})

/**
 * The allowed values come from the same lists the dropdowns are built from, so
 * the screen and the validator cannot drift apart.
 */
const Draft = z.object({
  general_reference: z.string().trim().max(64),
  /**
   * Which door the truck goes to. Not a field on the screen: it follows from
   * how the order was fulfilled, and letting somebody retype it is how a
   * forwarder ends up at the wrong building.
   */
  pickup_from: z.enum(PICKUP_FROM).default('BAMIDA'),
  cargo_readiness_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-09-30'),
  main_modality: z.enum(MODALITIES),
  main_category: z.enum(CATEGORIES),
  business_direction: z.enum(DIRECTIONS),
  delivery_term: z.enum(INCOTERMS).nullable(),
  pieces: z.number().int().min(0).max(100000),
  package_type_code: z.enum(PACKAGE_TYPES),
  description: z.string().trim().min(1, 'The cargo needs a description').max(200),
  consignee_name: z.string().trim().max(120),
  consignee_address: z.string().trim().max(400),
  notes: z.string().trim().max(2000),
  to: z.string().trim().max(400),
  cc: z.string().trim().max(400),
  lines: z.array(Line).max(200),
})

const Input = z.object({
  po_id: z.string().uuid('Invalid PO id'),
  draft: Draft,
})

export type CargoRequestResult = { ok: true; description: string } | { ok: false; error: string }

/** Keep a correction without releasing anything. */
export async function saveCargoRequest(input: z.infer<typeof Input>): Promise<CargoRequestResult> {
  const gate = await authorise(input)
  if (!gate.ok) return gate

  const { error, data } = await createAdminClient()
    .from('po_cargo_request')
    .update({ request: gate.draft, updated_at: new Date().toISOString(), updated_by: gate.userId })
    .eq('po_id', gate.poId)
    .is('sent_at', null)
    .select('po_id')
  if (error) {
    console.error('saveCargoRequest failed', error.message)
    return { ok: false, error: 'That could not be saved. Please try again.' }
  }
  if (!data || data.length === 0) {
    return { ok: false, error: 'This request has already been sent, so it can no longer be edited.' }
  }

  revalidatePath(`/purchase-orders/${gate.poId}`)
  return { ok: true, description: 'Saved. Nothing has been sent yet.' }
}

/** Release it. One conditional update claims the send before anything is posted. */
export async function approveAndSendCargoRequest(
  input: z.infer<typeof Input>,
): Promise<CargoRequestResult> {
  const gate = await authorise(input)
  if (!gate.ok) return gate
  const { poId, draft, userId } = gate

  if (!draft.to) {
    return { ok: false, error: 'Add the address this request should go to before sending it.' }
  }

  const admin = createAdminClient()
  const nowIso = new Date().toISOString()

  // The edit and the claim in one statement. Of two requests racing, one gets a
  // row back and sends; the other gets none and never contacts n8n.
  const { data: claimed, error: claimErr } = await admin
    .from('po_cargo_request')
    .update({ request: draft, updated_at: nowIso, updated_by: userId, sent_at: nowIso, sent_by: userId })
    .eq('po_id', poId)
    .is('sent_at', null)
    .select('po_id')
  if (claimErr) {
    console.error('approveAndSendCargoRequest claim failed', claimErr.message)
    return { ok: false, error: 'That could not be sent. Please try again.' }
  }
  if (!claimed || claimed.length === 0) {
    return { ok: false, error: 'This request has already been sent to Cargo Partner.' }
  }

  const { data: po } = await admin
    .from('purchase_orders')
    .select('po_number, master_ref')
    .eq('id', poId)
    .maybeSingle<{ po_number: string | null; master_ref: string | null }>()

  const sent = await notifyCargoPartnerReady(
    { poId, poNumber: po?.po_number ?? null, masterRef: po?.master_ref ?? null },
    draft,
  )

  if (!sent.sent) {
    // Nothing left the building, so hand the claim back and let them retry.
    await admin
      .from('po_cargo_request')
      .update({ sent_at: null, sent_by: null })
      .eq('po_id', poId)
    revalidatePath(`/purchase-orders/${poId}`)
    return { ok: false, error: FAILURE[sent.reason] }
  }

  await admin
    .from('po_cargo_request')
    .update({ sent_to: sent.recipients.to, sent_was_test: sent.recipients.isTest })
    .eq('po_id', poId)

  revalidatePath(`/purchase-orders/${poId}`)
  revalidatePath('/purchase-orders')
  return { ok: true, description: sendDescription(sent.recipients) }
}

const FAILURE: Record<'not_configured' | 'staging' | 'failed', string> = {
  not_configured:
    'The Cargo Partner email is not configured yet, so nothing was sent. Set N8N_CARGO_NOTIFY_WEBHOOK_URL and an address to send to.',
  staging: 'This is the staging environment, so nothing was sent.',
  failed: 'The email could not be sent. Nothing went out, so you can try again.',
}

type Gate =
  | { ok: true; poId: string; draft: z.infer<typeof Draft>; userId: string }
  | { ok: false; error: string }

async function authorise(input: unknown): Promise<Gate> {
  const auth = await getAuthorizedUser()
  if (!auth.ok) return { ok: false, error: auth.error }
  if (!auth.capabilities.has('po.create')) {
    return { ok: false, error: 'Forbidden: missing po.create capability' }
  }
  const parsed = Input.safeParse(input)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid input' }
  }
  const poId = parsed.data.po_id

  // Dean, 9 Sep 2026: the general reference is fixed and uneditable. It is the
  // key Cargo Partner index the shipment under and the key the SPOT lookup
  // searches on, so a typo here loses the shipment rather than renaming it.
  //
  // The screen shows it read-only, but this is where it is actually guaranteed:
  // every export of a 'use server' file is a callable endpoint, and a disabled
  // input stops nobody. Same for pickup_from, which follows from how the order
  // was fulfilled and is not a thing to choose.
  const { data: po } = await createAdminClient()
    .from('purchase_orders')
    .select('po_number, leg, fulfilment_type')
    .eq('id', poId)
    .maybeSingle<{ po_number: string | null; leg: string; fulfilment_type: string | null }>()
  if (!po) return { ok: false, error: 'That purchase order no longer exists.' }

  const draft = {
    ...parsed.data.draft,
    general_reference: po.po_number ?? parsed.data.draft.general_reference,
    pickup_from:
      po.leg === 'EB_GROUP_TO_SRO' && po.fulfilment_type === 'stock' ? ('EB_SRO' as const) : ('BAMIDA' as const),
  }

  return { ok: true, poId, draft, userId: auth.user.id }
}
