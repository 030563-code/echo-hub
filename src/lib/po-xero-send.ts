/**
 * Whether an approved purchase order leg made it into Xero, and what to say when it did not.
 *
 * Approving a Depot or Group leg posts it to n8n workflow Fz7xXgifva5n548u, which creates the
 * authorised Xero purchase order and then writes its id into purchase_orders.xero_po_id. That id
 * is the only proof the order is in Xero: the workflow writes nothing else back, and it writes the
 * id only after Xero has both created and authorised the order. Until 24 Sep 2026 a post that
 * failed raised a toast and nothing more, and the order could never be sent again, because
 * hub_approve_po_leg refuses a second approval.
 *
 * So a leg that should be in Xero and is not is worked out here from three things: the leg, the
 * Hub's own record of its posts (public.po_xero_sends), and the time. Pure: no database, no clock
 * and no server-only import, so the board, the order page, the actions and the tests all read the
 * same rules, and the caller passes the time in.
 */

import type { PurchaseOrder, PurchaseOrderLine } from '@/lib/erp-types'
import { raisingParty } from '@/lib/po-raising'
import { organisation } from '@/lib/organisations'

/**
 * The legs n8n turns into Xero purchase orders: the depot's order on Group, and Group's order on
 * s.r.o. SRO_TO_SUPPLIER is never created in Xero by design (Dean, 21 Sep 2026: "We are not doing
 * a PO to bamida via n8n"), so it is never flagged and never sent again from here.
 */
export const XERO_LEGS = ['DEPOT_TO_EB_GROUP', 'EB_GROUP_TO_SRO'] as const

export function sendsToXero(leg: string | null | undefined): boolean {
  return (XERO_LEGS as readonly string[]).includes(String(leg ?? ''))
}

/**
 * How long n8n has to write the Xero id back after a post before the leg counts as failed.
 * The workflow answers only once it has finished, so a clean run is back in seconds; the margin
 * is for a run that takes the post and then fails inside, which the Hub cannot otherwise see.
 */
export const XERO_SEND_GRACE_MS = 15 * 60 * 1000

/** One row of public.po_xero_sends, as the server reads it. */
export interface XeroSendRecord {
  po_id: string
  attempts: number
  last_attempt_at: string | null
  last_outcome: 'accepted' | 'failed' | 'timed_out' | null
  last_error: string | null
  claimed_at: string | null
  sandbox_at: string | null
}

/** The columns every reader selects, so a new one cannot be left unfetched. */
export const XERO_SEND_COLUMNS = 'po_id, attempts, last_attempt_at, last_outcome, last_error, claimed_at, sandbox_at'

/**
 * What a screen shows about a leg that should be in Xero and is not.
 *
 * failed   nothing more will happen by itself: say so everywhere approvers look, and offer
 *          "Send to Xero again".
 * waiting  a post may still be on its way. Said on the order page only, with the time it will
 *          count as failed.
 * sandbox  approved in the staging sandbox, which never posts to n8n. Staging shares the live
 *          database, so production sees these legs too and must not offer to send them.
 *
 * `attempts` travels with the view so a retry can prove it was decided on the latest attempt.
 */
export type XeroSendView = {
  kind: 'failed' | 'waiting' | 'sandbox'
  message: string
  attempts: number
}

/** A leg's fields this module reads. Plain strings, so a narrow select satisfies it as well as a full row. */
export type XeroSendLeg = {
  leg: string
  source: string
  status: string
  approved_at: string | null
  xero_po_id?: string | null
}

/** One leg whose send has failed, as the approvals page and the dashboard list it. */
export type XeroSendFailure = { id: string; po_number: string; leg: string; message: string }

/** Statuses on which a leg has not been, or will never be, handed to Xero. */
const NOT_HANDED_OVER = new Set(['requested', 'rejected', 'cancelled'])

/**
 * True once n8n has written the Xero purchase order id back. The id is text, null until the
 * write-back, and the write-back only runs after Xero has created and authorised the order by
 * that id, so a blank can only mean something went wrong; it counts as missing.
 */
export function hasXeroId(po: { xero_po_id?: string | null }): boolean {
  return typeof po.xero_po_id === 'string' && po.xero_po_id !== ''
}

/** True for a Hub leg that has been approved and should therefore be in Xero. */
export function belongsInXero(po: XeroSendLeg): boolean {
  return po.source === 'hub' && sendsToXero(po.leg) && !!po.approved_at && !NOT_HANDED_OVER.has(po.status)
}

/**
 * The state of a leg's hand-off to Xero, or null when there is nothing to say: the leg is not
 * one n8n puts in Xero, is not approved, or is already in Xero.
 *
 * The Xero id wins over everything. A post the Hub recorded as failed or timed out can still have
 * finished in n8n, and once the id is back the order is in Xero whatever the Hub last heard.
 */
export function xeroSendView(po: XeroSendLeg, record: XeroSendRecord | null | undefined, nowMs: number): XeroSendView | null {
  if (!belongsInXero(po) || hasXeroId(po)) return null
  const attempts = record?.attempts ?? 0
  const tried = attempts > 1 ? ` Sent ${attempts} times.` : ''

  // A "Send to Xero again" that took its claim and has not reported back. Either it is still
  // running, or the server stopped before it could record the outcome.
  if (record?.claimed_at) {
    const at = whenUtc(record.claimed_at)
    if (nowMs < Date.parse(record.claimed_at) + XERO_SEND_GRACE_MS) {
      return { kind: 'waiting', attempts, message: `Being sent to Xero again since ${at}.` }
    }
    return {
      kind: 'failed',
      attempts,
      message: `Not in Xero: a send started at ${at} and never reported back, and no Xero purchase order has come back since.${tried}`,
    }
  }

  if (record?.last_attempt_at) {
    const at = whenUtc(record.last_attempt_at)
    const error = record.last_error ?? 'The Hub did not record why.'
    // A refusal, no answer at all, or no webhook configured: nothing is on its way.
    if (record.last_outcome === 'failed') {
      return { kind: 'failed', attempts, message: `Not in Xero: the send failed at ${at}. ${error}${tried}` }
    }
    const deadline = Date.parse(record.last_attempt_at) + XERO_SEND_GRACE_MS
    if (record.last_outcome === 'timed_out') {
      if (nowMs < deadline) {
        return {
          kind: 'waiting',
          attempts,
          message: `Not in Xero yet: the send at ${at} failed. ${error} n8n may still finish it. If no Xero purchase order comes back by ${timeUtc(deadline)}, it can be sent again.`,
        }
      }
      return {
        kind: 'failed',
        attempts,
        message: `Not in Xero: the send failed at ${at}. ${error} No Xero purchase order has come back since.${tried}`,
      }
    }
    // Accepted. n8n answers once its run is over, so a missing id this long after is a run that
    // took the order and failed inside.
    if (nowMs < deadline) {
      return { kind: 'waiting', attempts, message: `Sent to Xero at ${at}. Waiting for n8n to write the Xero purchase order back.` }
    }
    return {
      kind: 'failed',
      attempts,
      message: `Not in Xero: n8n took the order at ${at}, but no Xero purchase order came back.${tried}`,
    }
  }

  if (record?.sandbox_at) {
    return {
      kind: 'sandbox',
      attempts,
      message: `Approved in the staging sandbox at ${whenUtc(record.sandbox_at)}. The sandbox never sends to Xero, so this order is not in Xero.`,
    }
  }

  // No record of any post: approved before the Hub kept one, or the server stopped between the
  // approval and the post. The clock runs from the approval.
  const approvedAt = String(po.approved_at)
  if (nowMs < Date.parse(approvedAt) + XERO_SEND_GRACE_MS) {
    return { kind: 'waiting', attempts, message: `Approved at ${whenUtc(approvedAt)}. Waiting for the Xero purchase order to come back.` }
  }
  return { kind: 'failed', attempts, message: `Not in Xero: approved at ${whenUtc(approvedAt)}, but no Xero purchase order came back.` }
}

/**
 * The Xero organisation a leg's purchase order belongs in, by its legal name: the depot's company
 * for a Depot leg, Echo Barrier Group Limited for a Group leg. Null for a party nobody mapped.
 */
export function xeroOrganisationName(po: Pick<PurchaseOrder, 'from_entity'>): string | null {
  const party = raisingParty(po.from_entity)
  return party ? organisation(party.org).legalName : null
}

// ---------------------------------------------------------------------------
// Lines with no unit price
// ---------------------------------------------------------------------------

export type UnpricedLine = { id: string; sku: string; product_name: string | null }

/**
 * The lines n8n would send to Xero at UnitAmount 0, because its line builder does
 * `UnitAmount: l.unit_price || 0`. Null, zero and anything that is not a positive number all
 * count. A price is only ever entered when an order is raised; nothing in the Hub adds one later.
 */
export function unpricedLines(
  lines: readonly Pick<PurchaseOrderLine, 'id' | 'sku' | 'product_name' | 'unit_price'>[],
): UnpricedLine[] {
  return lines
    .filter((l) => !(Number(l.unit_price) > 0))
    .map((l) => ({ id: l.id, sku: l.sku, product_name: l.product_name ?? null }))
}

/** "Echo Barrier H9 (EBH9NA), CCSNA": the product first, the SKU to find it by. */
export function describeLines(lines: readonly UnpricedLine[]): string {
  return lines.map((l) => (l.product_name ? `${l.product_name} (${l.sku})` : l.sku)).join(', ')
}

/** The refusal an approval gets when unpriced lines were not confirmed. */
export function unpricedRefusal(poNumber: string, lines: readonly UnpricedLine[]): string {
  const some = lines.length === 1 ? '1 line' : `${lines.length} lines`
  return `${poNumber} has ${some} with no unit price: ${describeLines(lines)}. The Hub cannot add a price to an order once it is raised, so Xero would receive ${lines.length === 1 ? 'it' : 'them'} at 0. Choose "Approve with these lines at 0 in Xero" to go ahead.`
}

// ---------------------------------------------------------------------------
// Times, in UTC and labelled
// ---------------------------------------------------------------------------

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/**
 * "14:02 UTC on 24 Sep". Always UTC and always labelled: the people reading it sit in four time
 * zones, and the words are built on the server, where a local time would be the server's.
 */
export function whenUtc(iso: string): string {
  const ms = Date.parse(iso)
  if (Number.isNaN(ms)) return iso
  const d = new Date(ms)
  return `${timeUtc(ms)} on ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`
}

function timeUtc(ms: number): string {
  const d = new Date(ms)
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')} UTC`
}
