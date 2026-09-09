import 'server-only'

/**
 * Tell Cargo Partner a container is ready to collect from Bamida.
 *
 * Not a 'use server' file. Only the action modules are; every export of one is
 * a callable endpoint, and this has no business being one.
 *
 * Dean's brief, 8 Sep 2026: when Bamida press "Manufacturing finished", the Hub
 * raises the transport order and emails Cargo Partner with Juraj in copy. This
 * is the EMAIL half only. It makes no API call to Cargo Partner, by standing
 * instruction: no transport order, document or event is ever written to their
 * system, on production or test, without Dean saying yes to that specific call.
 *
 * Dean, 9 Sep 2026: nothing goes to the forwarder unreviewed. Bamida finishing
 * an order DRAFTS the request (see cargo-request.ts); a person at Echo Barrier
 * reads it, corrects it and releases it. So this module no longer decides what
 * a request says. It takes an approved draft and posts it.
 *
 * The Hub still decides who receives it and n8n owns the wording, the same split
 * as the SRO and Bamida emails. A workflow holding its own copy of an address
 * list would mail a forwarder while the Hub believed everything was going to the
 * test address. That is also why the draft's addresses go through
 * resolveRecipients here rather than being trusted as stored.
 */

import { createAdminClient } from '@/lib/supabase/admin'
import { externalCallsDisabled, hubBaseUrl } from '@/lib/env'
import { resolveRecipients, type ResolvedRecipients } from '@/lib/email-recipients'
import { SHIPPER, PICKUP_PARTIES, OFFICE_IN_CHARGE, type CargoDraft } from '@/lib/cargo-request'
import { entityLabel } from '@/lib/depot-constants'

const TIMEOUT_MS = 15_000

/** Juraj sees every one of these, by Dean's instruction. */
const DEFAULT_CC = 'juraj@echobarrier.eu'

/** Which purchase order this request belongs to. Not editable. */
export type CargoRequestMeta = {
  poId: string
  poNumber: string | null
  masterRef: string | null
}

export type NotifyCargoResult =
  | { sent: true; recipients: ResolvedRecipients }
  | { sent: false; reason: 'not_configured' | 'staging' | 'failed' }

/**
 * Where a new draft starts from. No default `to` on purpose: Cargo Partner's
 * booking address is not recorded anywhere in the Hub, and guessing a
 * forwarder's inbox is not a thing to do. An empty one shows on the review
 * screen as a field somebody has to fill before the request can be released.
 */
export function defaultCargoRecipients(): { to: string; cc: string } {
  return {
    to: String(process.env.CARGO_NOTIFY_TO ?? '').trim(),
    cc: String(process.env.CARGO_NOTIFY_CC ?? '').trim() || DEFAULT_CC,
  }
}

/**
 * Where the container is going: the depot that started the chain.
 *
 * The Bamida order's parent is the SRO leg and its parent is the depot leg, so
 * the destination is two steps up. Returns nulls rather than throwing, because
 * an unknown consignee is a field for a person to fill in on the review screen;
 * it is not worth losing the draft that a container is ready.
 */
export async function resolveConsignee(poId: string): Promise<{ depot: string | null; address: string | null }> {
  const admin = createAdminClient()
  type Leg = { id: string; parent_po_id: string | null; from_entity: string | null; delivery_address: string | null }

  let current: Leg | null = null
  let address: string | null = null
  let nextId: string | null = poId

  // Walk to the ROOT of the chain rather than counting hops upward. The old
  // code did exactly three parents because it assumed it was always handed the
  // Bamida order; handed an SRO leg instead it stopped one short and named
  // Echo Barrier Group as the destination. The depot that started the chain is
  // whichever leg has no parent, however many legs there happen to be.
  //
  // Bounded at 6 so a cycle in the data cannot spin here.
  for (let hop = 0; hop < 6 && nextId; hop++) {
    const { data }: { data: Leg | null } = await admin
      .from('purchase_orders')
      .select('id, parent_po_id, from_entity, delivery_address')
      .eq('id', nextId)
      .maybeSingle<Leg>()
    if (!data) break
    current = data
    // The nearest delivery address on the way up wins, so a leg that carries
    // one is preferred over a root that does not.
    address = address ?? data.delivery_address ?? null
    nextId = data.parent_po_id
  }

  if (!current) return { depot: null, address: null }
  return {
    // Named, not coded: this ends up on a document a freight forwarder reads.
    depot: current.from_entity ? entityLabel(current.from_entity) : null,
    address: address ?? current.delivery_address ?? null,
  }
}

/**
 * Best effort. The finished timestamp and the approval are both already written
 * when this runs, so a mail failure is something to report and retry, never a
 * reason to un-finish an order Bamida have finished.
 */
export async function notifyCargoPartnerReady(
  meta: CargoRequestMeta,
  draft: CargoDraft,
): Promise<NotifyCargoResult> {
  if (externalCallsDisabled()) return { sent: false, reason: 'staging' }

  const webhookUrl = String(process.env.N8N_CARGO_NOTIFY_WEBHOOK_URL ?? '').trim()
  if (!webhookUrl) return { sent: false, reason: 'not_configured' }
  if (!String(draft.to ?? '').trim()) return { sent: false, reason: 'not_configured' }

  const recipients = resolveRecipients({ to: draft.to, cc: draft.cc })
  const payload = buildCargoNotifyPayload(meta, draft, recipients)

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(process.env.N8N_CARGO_NOTIFY_WEBHOOK_SECRET
          ? { 'x-hub-secret': process.env.N8N_CARGO_NOTIFY_WEBHOOK_SECRET }
          : {}),
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
      cache: 'no-store',
    })
    if (!res.ok) return { sent: false, reason: 'failed' }
    return { sent: true, recipients }
  } catch {
    return { sent: false, reason: 'failed' }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * The webhook body, assembled from the approved draft. Split out so it can be
 * asserted in a unit test without a network.
 */
export function buildCargoNotifyPayload(
  meta: CargoRequestMeta,
  draft: CargoDraft,
  recipients: ResolvedRecipients,
) {
  return {
    action: 'cargo_collection_ready',
    to: recipients.to,
    cc: recipients.cc,
    bcc: recipients.bcc,
    is_test: recipients.isTest,
    /** Who it would have reached. n8n prints this in the body of a test send. */
    intended: recipients.intended,

    po_id: meta.poId,
    po_number: meta.poNumber,
    master_ref: meta.masterRef,

    shipment: {
      /** The key Cargo Partner index on, and the one the SPOT lookup searches. */
      general_reference: draft.general_reference || meta.poNumber,
      main_modality: draft.main_modality,
      main_category: draft.main_category,
      business_direction: draft.business_direction,
      /**
       * Null until somebody sets it. The email then asks for it rather than
       * carrying an invented term that decides who pays for freight.
       */
      delivery_term: draft.delivery_term,
      cargo_readiness_date: draft.cargo_readiness_date,
      pieces: draft.pieces,
      package_type_code: draft.package_type_code,
      description: draft.description,
      notes: draft.notes || null,
    },

    participants: {
      shipper: SHIPPER,
      principal: SHIPPER,
      main_invoice_to: SHIPPER,
      pickup: PICKUP_PARTIES[draft.pickup_from] ?? PICKUP_PARTIES.BAMIDA,
      consignee: {
        depot: draft.consignee_name || null,
        address: draft.consignee_address || null,
      },
      office_in_charge: OFFICE_IN_CHARGE,
    },

    lines: draft.lines,

    link: `${hubBaseUrl()}/purchase-orders/${meta.poId}`,
  }
}
