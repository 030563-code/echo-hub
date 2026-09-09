import 'server-only'

/**
 * Tell Echo Barrier that Bamida have finished an order.
 *
 * Dean, 9 Sep 2026: when the manufacturer presses finished, an email should go
 * out saying the purchase order is ready for shipment. In production that is
 * Juraj; during testing it is whoever the test switch names.
 *
 * This is the email the approval step made necessary. Before it, finishing sent
 * the forwarder an email and everybody knew. Now finishing drafts a request that
 * waits for a person, and a queue nobody is told about is a queue nobody works.
 *
 * INTERNAL. It goes to us, not to the forwarder, and it asks somebody to open
 * the shipment request and release it. The email that leaves the company is
 * still the one a person approves: see notify-cargo-partner.ts.
 *
 * It shares the cargo webhook and its secret on purpose. Both are the same
 * conversation about the same order at the same moment, and a second webhook
 * would mean a second path, a second credential and a second thing to publish
 * before any of this works.
 */

import { externalCallsDisabled, hubBaseUrl } from '@/lib/env'
import { resolveRecipients, type ResolvedRecipients } from '@/lib/email-recipients'
import type { CargoDraft } from '@/lib/cargo-request'
import type { CargoRequestMeta, NotifyCargoResult } from '@/app/actions/purchase-orders/notify-cargo-partner'

const TIMEOUT_MS = 15_000

/**
 * Juraj, unless told otherwise. Unlike the forwarder's booking inbox this is an
 * address we already hold and already copy on every request, so defaulting to
 * it is not guessing.
 */
const DEFAULT_TO = 'juraj@echobarrier.eu'

export function readyNotifyRecipients(): { to: string; cc: string } {
  return {
    to: String(process.env.READY_NOTIFY_TO ?? '').trim() || DEFAULT_TO,
    cc: String(process.env.READY_NOTIFY_CC ?? '').trim(),
  }
}

/**
 * Best effort, and always after the finished timestamp is written. Bamida have
 * finished the order whatever our mail server does, and a failure here must
 * never leave them pressing a button that says it did not work.
 */
export async function notifyReadyForShipment(
  meta: CargoRequestMeta,
  draft: CargoDraft,
): Promise<NotifyCargoResult> {
  if (externalCallsDisabled()) return { sent: false, reason: 'staging' }

  const webhookUrl = String(process.env.N8N_CARGO_NOTIFY_WEBHOOK_URL ?? '').trim()
  if (!webhookUrl) return { sent: false, reason: 'not_configured' }

  const { to, cc } = readyNotifyRecipients()
  const recipients = resolveRecipients({ to, cc })
  const payload = buildReadyNotifyPayload(meta, draft, recipients)

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
 * The body is built from the draft the finish just created, so the figures in
 * the email and the figures on the approval screen cannot disagree.
 */
export function buildReadyNotifyPayload(
  meta: CargoRequestMeta,
  draft: CargoDraft,
  recipients: ResolvedRecipients,
) {
  return {
    /** n8n picks the template off this. The forwarder email is the other one. */
    action: 'manufacturing_ready_for_shipment',
    to: recipients.to,
    cc: recipients.cc,
    bcc: recipients.bcc,
    is_test: recipients.isTest,
    intended: recipients.intended,

    po_id: meta.poId,
    po_number: meta.poNumber,
    master_ref: meta.masterRef,

    shipment: {
      general_reference: draft.general_reference || meta.poNumber,
      cargo_readiness_date: draft.cargo_readiness_date,
      pieces: draft.pieces,
      package_type_code: draft.package_type_code,
      description: draft.description,
      /** Null until somebody sets it on the approval screen. Said out loud. */
      delivery_term: draft.delivery_term,
    },

    lines: draft.lines,

    /** Straight to the shipment request waiting to be released. */
    link: `${hubBaseUrl()}/purchase-orders/${meta.poId}`,
  }
}
