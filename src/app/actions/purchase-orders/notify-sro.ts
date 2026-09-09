import 'server-only'

/**
 * Tell Juraj a purchase order has reached SRO and is waiting for him.
 *
 * Not a 'use server' file. Only the action modules are; every export of one is
 * a callable endpoint, and this has no business being one. decide-po.ts calls
 * it after the Hub record is already saved.
 *
 * Dean, 8 Sep 2026: when the PO flow from a US depot reaches SRO, email Juraj
 * that there is an order in the system for him to evaluate. Today nothing
 * reaches him from the Hub at all: N8N_PO_APPROVED_WEBHOOK_URL points at the
 * `po-hub-approved` workflow, which is switched off, and the older Xero-polling
 * workflow only emails him about orders it polled itself, never about ones the
 * Hub raised.
 *
 * This is deliberately NOT a second copy of that older email. Keep both until
 * the Xero poll is retired.
 *
 * The Hub decides who receives it, n8n owns the wording. Letting n8n hold its
 * own copy of the address list would make the test switch unenforceable: a
 * workflow with Juraj's address baked in will happily mail him while the Hub
 * believes everything is going to Dean.
 */

import { externalCallsDisabled, hubBaseUrl } from '@/lib/env'
import { resolveRecipients, type ResolvedRecipients } from '@/lib/email-recipients'

const TIMEOUT_MS = 15_000

/** Who hears that an order has landed at SRO. Config, so it changes without a deploy. */
const DEFAULT_TO = 'juraj@echobarrier.eu'

export type SroPoLine = {
  product_name: string | null
  quantity: number | null
}

export type NotifySroInput = {
  /** The EB_GROUP_TO_SRO child: the order now sitting with SRO. */
  poId: string
  poNumber: string | null
  masterRef: string | null
  /** The leg this came from, so the body can say which depot started it. */
  fromDepot: string | null
  /** The approver who released it, for "raised by" in the body. */
  approvedBy: string
  lines: SroPoLine[]
}

export type NotifySroResult =
  | { sent: true; recipients: ResolvedRecipients }
  | { sent: false; reason: 'not_configured' | 'staging' | 'failed' }

/**
 * Best-effort. The PO is already saved when this runs, so a mail failure is a
 * warning on the approval, never a reason to undo an approval that happened.
 */
export async function notifySroPoReady(input: NotifySroInput): Promise<NotifySroResult> {
  if (externalCallsDisabled()) return { sent: false, reason: 'staging' }

  const webhookUrl = String(process.env.N8N_SRO_NOTIFY_WEBHOOK_URL ?? '').trim()
  if (!webhookUrl) return { sent: false, reason: 'not_configured' }

  const recipients = resolveRecipients({
    to: String(process.env.SRO_NOTIFY_TO ?? '').trim() || DEFAULT_TO,
    cc: process.env.SRO_NOTIFY_CC,
  })

  const payload = buildSroNotifyPayload(input, recipients)

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(process.env.N8N_SRO_NOTIFY_WEBHOOK_SECRET
          ? { 'x-hub-secret': process.env.N8N_SRO_NOTIFY_WEBHOOK_SECRET }
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
 * Split out so the payload can be asserted in a unit test without a network.
 * Exported for the tests; nothing else should call it.
 */
export function buildSroNotifyPayload(input: NotifySroInput, recipients: ResolvedRecipients) {
  return {
    action: 'sro_po_ready',
    to: recipients.to,
    cc: recipients.cc,
    bcc: recipients.bcc,
    is_test: recipients.isTest,
    /** Who it would have reached. n8n prints this in the body of a test send. */
    intended: recipients.intended,
    po_id: input.poId,
    po_number: input.poNumber,
    master_ref: input.masterRef,
    from_depot: input.fromDepot,
    approved_by: input.approvedBy,
    /** Straight into the fulfilment step, not the board. */
    link: `${hubBaseUrl()}/purchase-orders/${input.poId}`,
    lines: input.lines.map((line) => ({
      product_name: line.product_name,
      quantity: line.quantity,
    })),
  }
}
