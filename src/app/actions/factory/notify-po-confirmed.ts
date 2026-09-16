import 'server-only'

/**
 * The email the manufacturer gets back when they confirm a purchase order.
 *
 * Dean, 16 Sep 2026: "Next they receive a confirmation email of them accepting
 * the purchase order with the dates they put in ... The confirmation email
 * should remind them and the hub should also make this clear."
 *
 * So it does two jobs. It is their receipt, quoting their own dates back so a
 * mistyped year is caught by the person who typed it. And it is where the
 * invoice rule is written down: we cannot pay an invoice for an order that is
 * not marked finished in the Hub, and the place that gets read months later is
 * an email, not a screen they visited once.
 *
 * It goes to them with us in copy, through the same webhook the order
 * notification uses, because it is the same conversation about the same order
 * with the same party. Recipients go through resolveRecipients, so while the
 * test switch is on this lands with Dean and nowhere else.
 *
 * WHO "THEM" IS COMES FROM THE ORDER, NOT FROM THE LOGIN. Dean, 16 Sep 2026:
 * "cant we link an email to a PO by what Juraj put in in that step just before
 * manufacturing?" Juraj addresses each order on the send card, and the Hub
 * keeps those addresses on the row. Using them instead of the account that
 * pressed Confirm means the receipt reaches the people who are actually making
 * the thing, and it frees the login to be any address at all, including a
 * shared one that receives no mail.
 */

import { externalCallsDisabled, hubBaseUrl } from '@/lib/env'
import { resolveRecipients, type ResolvedRecipients } from '@/lib/email-recipients'
import { readyNotifyRecipients } from '@/app/actions/purchase-orders/notify-ready-for-shipment'

const TIMEOUT_MS = 15_000

export interface PoConfirmedMeta {
  poId: string
  poNumber: string | null
  confirmedAt: string
  confirmedBy: string | null
  estStart: string | null
  estFinish: string | null
  lines: Array<{ product_name: string | null; quantity: number | null }>
  /** The manufacturer's own addresses, as the purchase order was addressed. */
  to: string[]
  /** Any further manufacturer contacts copied on the purchase order. */
  cc: string[]
}

export type NotifyPoConfirmedResult =
  | { sent: true; recipients: ResolvedRecipients }
  | { sent: false; reason: 'staging' | 'not_configured' | 'no_recipient' | 'failed' }

export function buildPoConfirmedPayload(meta: PoConfirmedMeta, recipients: ResolvedRecipients) {
  return {
    /** n8n picks the wording off this. The order notification is the other one. */
    action: 'manufacturing_po_confirmed',
    to: recipients.to,
    cc: recipients.cc,
    bcc: recipients.bcc,
    is_test: recipients.isTest,
    intended: recipients.intended,

    po_id: meta.poId,
    po_number: meta.poNumber,
    confirmed_at: meta.confirmedAt,
    confirmed_by: meta.confirmedBy,
    est_start: meta.estStart,
    est_finish: meta.estFinish,

    /**
     * No SKU. `EBH9NA` is our own database code and means nothing to a factory,
     * so it does not travel: not printed, and not carried in the payload
     * either, because the webhook body is readable in every n8n execution log.
     */
    lines: meta.lines.map((l) => ({ product_name: l.product_name, quantity: l.quantity })),

    /** Back to the order, where the finished button is. */
    link: `${hubBaseUrl()}/factory/${meta.poId}`,
  }
}

export async function notifyPoConfirmed(meta: PoConfirmedMeta): Promise<NotifyPoConfirmedResult> {
  if (externalCallsDisabled()) return { sent: false, reason: 'staging' }

  const webhookUrl = String(process.env.N8N_BAMIDA_PO_WEBHOOK_URL ?? '').trim()
  if (!webhookUrl) return { sent: false, reason: 'not_configured' }

  const clean = (list: readonly (string | null | undefined)[]) =>
    list.map((v) => String(v ?? '').trim()).filter(Boolean)

  const to = clean(meta.to).join(', ')
  if (!to) return { sent: false, reason: 'no_recipient' }

  // Anyone else at the manufacturer the order was copied to, plus us: the same
  // people the ready-for-shipment email already reaches, so there is one answer
  // to "who at Echo Barrier hears about this order".
  const internal = readyNotifyRecipients()
  const cc = clean([...meta.cc, internal.to, internal.cc]).join(', ')
  const recipients = resolveRecipients({ to, cc })
  const payload = buildPoConfirmedPayload(meta, recipients)

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(process.env.N8N_BAMIDA_PO_WEBHOOK_SECRET
          ? { 'x-hub-secret': process.env.N8N_BAMIDA_PO_WEBHOOK_SECRET }
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
