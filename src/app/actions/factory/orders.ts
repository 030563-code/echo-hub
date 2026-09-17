'use server'

/**
 * The four things the manufacturer may do, and nothing else.
 *
 * Every export of a 'use server' file is a callable endpoint, so each of these
 * stands on its own: the session, then the capability, then the shape of the
 * input, then whether this account may touch THIS order. The last one is
 * factoryOrderVisible, the same predicate the list page uses, so an order they
 * cannot see is an order they cannot write to. None of them takes anything
 * about the order except its id: no dates for another order, no prices, no
 * recipients.
 *
 * The heavy lifting lives in @/lib/factory/updates, which is server-only rather
 * than 'use server' for the same reason this file is so thin.
 */

import { z } from 'zod'
import { getAuthorizedUser } from '@/lib/authz'
import { createAdminClient } from '@/lib/supabase/admin'
import { factoryOrderVisible, loadFactoryOrder } from '@/lib/factory/orders'
import {
  applyManufacturingDates,
  confirmManufacturingOrder,
  finishManufacturingOrder,
  DateInput,
  type ManufacturingUpdateResult,
} from '@/lib/factory/updates'
import { notifyPoConfirmed } from '@/app/actions/factory/notify-po-confirmed'
import { renderSupplierDocument } from '@/lib/bamida-po-document'
import { factoryLogin, loadSendContacts } from '@/lib/send-contacts'
import { factoryStrings } from '@/lib/factory/locale.server'
import type { FactoryStrings } from '@/lib/factory/strings'

const PoId = z.object({ poId: z.string().uuid() })
const DatesSchema = PoId.extend({ estStart: DateInput, estFinish: DateInput })

export type FactoryActionResult = ManufacturingUpdateResult
export type FactoryPdfResult =
  | { ok: true; filename: string; base64: string }
  | { ok: false; error: string }

/**
 * Session, capability, shape, then record. Returns the authorised user so the
 * caller can stamp who acted.
 *
 * Takes the resolved string table rather than reading the cookie itself, so one
 * action resolves the language once and every refusal it can produce comes back
 * in the same one.
 */
async function gate(poId: string, capability: 'factory.view' | 'factory.update', t: FactoryStrings) {
  const auth = await getAuthorizedUser()
  if (!auth.ok) return { ok: false as const, error: auth.error }
  // Left in English on purpose: this one names a capability key and only
  // appears if somebody calls the endpoint without holding it, which the screens
  // themselves cannot do.
  if (!auth.capabilities.has(capability)) {
    return { ok: false as const, error: `Forbidden: missing ${capability} capability` }
  }
  if (!(await factoryOrderVisible(poId))) return { ok: false as const, error: t.errOrderNotYours }
  return { ok: true as const, auth }
}

/** Change the estimated dates. Allowed before and after confirming, until finished. */
export async function saveFactoryDates(input: {
  poId: string
  estStart: string | null
  estFinish: string | null
}): Promise<FactoryActionResult> {
  const { t } = await factoryStrings()
  const parsed = DatesSchema.safeParse(input)
  if (!parsed.success) return { ok: false, error: t.errInvalidDates }

  const gated = await gate(parsed.data.poId, 'factory.update', t)
  if (!gated.ok) return { ok: false, error: gated.error }

  return applyManufacturingDates(
    createAdminClient(),
    parsed.data.poId,
    { estStart: parsed.data.estStart, estFinish: parsed.data.estFinish },
    gated.auth.user.id,
    t,
  )
}

/**
 * Confirm the purchase order, which is the step that tells us they have taken
 * it on and when. Both dates are required; the lib refuses without them.
 *
 * The email is best effort and comes after the row is written. They have
 * confirmed either way, and a mail server having a bad minute must not make it
 * look otherwise.
 */
export async function confirmFactoryOrder(input: {
  poId: string
  estStart: string | null
  estFinish: string | null
}): Promise<FactoryActionResult> {
  const { t } = await factoryStrings()
  const parsed = DatesSchema.safeParse(input)
  if (!parsed.success) return { ok: false, error: t.errInvalidDates }

  const gated = await gate(parsed.data.poId, 'factory.update', t)
  if (!gated.ok) return { ok: false, error: gated.error }

  const admin = createAdminClient()
  const confirmed = await confirmManufacturingOrder(
    admin,
    parsed.data.poId,
    { estStart: parsed.data.estStart, estFinish: parsed.data.estFinish },
    gated.auth.user.id,
    t,
  )
  if (!confirmed.ok) return confirmed

  const order = await loadFactoryOrder(parsed.data.poId)
  const { data: who } = await admin
    .from('profiles')
    .select('display_name')
    .eq('id', gated.auth.user.id)
    .maybeSingle<{ display_name: string | null }>()

  // WHERE THE RECEIPT GOES. Dean, 16 Sep 2026: "cant we link an email to a PO
  // by what Juraj put in in that step just before manufacturing?" It is on the
  // row already: the addresses the order was sent to. The Hub account that
  // pressed Confirm is deliberately not used, because one shared login may
  // stand for several people and its address may be one nobody there reads.
  const { data: addressed } = await admin
    .from('po_manufacturing')
    .select('intended_to, intended_cc, sent_to')
    .eq('po_id', parsed.data.poId)
    .maybeSingle<{
      intended_to: string[] | null
      intended_cc: string[] | null
      sent_to: string[] | null
    }>()

  // sent_to covers an order sent before the intended lists existed: it is where
  // that order's own email actually went.
  const addressedTo = addressed?.intended_to?.length ? addressed.intended_to : (addressed?.sent_to ?? [])

  const told = await notifyPoConfirmed({
    poId: parsed.data.poId,
    poNumber: order?.po_number ?? null,
    confirmedAt: confirmed.confirmedAt ?? new Date().toISOString(),
    confirmedBy: who?.display_name ?? null,
    estStart: parsed.data.estStart,
    estFinish: parsed.data.estFinish,
    lines: order?.lines ?? [],
    to: addressedTo,
    cc: addressed?.intended_cc ?? [],
    // Same sign-in block as the order email. This is the one that asks them to
    // come back later and press finished, which is when it is needed.
    login: factoryLogin(await loadSendContacts('manufacturing')),
  })

  if (told.sent) {
    await admin
      .from('po_manufacturing')
      .update({
        confirmation_emailed_at: new Date().toISOString(),
        confirmation_was_test: told.recipients.isTest,
      })
      .eq('po_id', parsed.data.poId)
    return { ok: true }
  }

  // Confirmed, but say so honestly rather than pretending an email went.
  console.error('confirmFactoryOrder email not sent', parsed.data.poId, told.reason)
  return {
    ok: false,
    error: t.errConfirmEmailFailed,
  }
}

/** Manufacturing finished. Refused until the order has been confirmed. */
export async function markFactoryFinished(input: { poId: string }): Promise<FactoryActionResult> {
  const { t } = await factoryStrings()
  const parsed = PoId.safeParse(input)
  if (!parsed.success) return { ok: false, error: t.errInvalidOrder }

  const gated = await gate(parsed.data.poId, 'factory.update', t)
  if (!gated.ok) return { ok: false, error: gated.error }

  return finishManufacturingOrder(createAdminClient(), parsed.data.poId, gated.auth.user.id, t)
}

/**
 * The purchase order document, the same one the email used to attach.
 *
 * Dean, 16 Sep 2026: "The purchase order no longer goes via pdf in the email.
 * They can download the purchase order in the manufacturing tab next to the
 * relevant one."
 *
 * Built with the SERVICE-ROLE client: loadSroPoBom and getSupplierByCode read
 * with the caller's client by default, and this caller holds none of the
 * capabilities can_read_po() wants, so both would come back empty. Only the
 * finished bytes leave this function. The SroPoBom behind them carries our SRO
 * cost snapshot and never crosses the boundary.
 */
export async function downloadFactoryOrderPdf(input: { poId: string }): Promise<FactoryPdfResult> {
  const { t } = await factoryStrings()
  const parsed = PoId.safeParse(input)
  if (!parsed.success) return { ok: false, error: t.errInvalidOrder }

  const gated = await gate(parsed.data.poId, 'factory.view', t)
  if (!gated.ok) return { ok: false, error: gated.error }

  // The SPECIFICATION, never the priced one. What the factory builds from, and
  // the only one of the two that carries no prices at all.
  const document = await renderSupplierDocument(parsed.data.poId, 'specification')
  if (!document.ok) return { ok: false, error: t.errNoDocument }
  return document
}
