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
import { loadSroPoBom } from '@/lib/bom'
import { getSupplierByCode } from '@/lib/suppliers'
import { buildBamidaPo, type BamidaSupplier } from '@/lib/bamida-po'
import { buildBamidaPoPdf } from '@/lib/bamida-po-pdf'
import { displayPoNumber } from '@/lib/po-number'

const PoId = z.object({ poId: z.string().uuid() })
const DatesSchema = PoId.extend({ estStart: DateInput, estFinish: DateInput })

export type FactoryActionResult = ManufacturingUpdateResult
export type FactoryPdfResult =
  | { ok: true; filename: string; base64: string }
  | { ok: false; error: string }

const NOT_YOURS = 'This order is not available.'

/**
 * Session, capability, shape, then record. Returns the authorised user so the
 * caller can stamp who acted.
 */
async function gate(poId: string, capability: 'factory.view' | 'factory.update') {
  const auth = await getAuthorizedUser()
  if (!auth.ok) return { ok: false as const, error: auth.error }
  if (!auth.capabilities.has(capability)) {
    return { ok: false as const, error: `Forbidden: missing ${capability} capability` }
  }
  if (!(await factoryOrderVisible(poId))) return { ok: false as const, error: NOT_YOURS }
  return { ok: true as const, auth }
}

/** Change the estimated dates. Allowed before and after confirming, until finished. */
export async function saveFactoryDates(input: {
  poId: string
  estStart: string | null
  estFinish: string | null
}): Promise<FactoryActionResult> {
  const parsed = DatesSchema.safeParse(input)
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid dates' }

  const gated = await gate(parsed.data.poId, 'factory.update')
  if (!gated.ok) return { ok: false, error: gated.error }

  return applyManufacturingDates(
    createAdminClient(),
    parsed.data.poId,
    { estStart: parsed.data.estStart, estFinish: parsed.data.estFinish },
    gated.auth.user.id,
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
  const parsed = DatesSchema.safeParse(input)
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid dates' }

  const gated = await gate(parsed.data.poId, 'factory.update')
  if (!gated.ok) return { ok: false, error: gated.error }

  const admin = createAdminClient()
  const confirmed = await confirmManufacturingOrder(
    admin,
    parsed.data.poId,
    { estStart: parsed.data.estStart, estFinish: parsed.data.estFinish },
    gated.auth.user.id,
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
    error:
      'Confirmed, and we have your dates. The confirmation email could not be sent, so keep this page as your record.',
  }
}

/** Manufacturing finished. Refused until the order has been confirmed. */
export async function markFactoryFinished(input: { poId: string }): Promise<FactoryActionResult> {
  const parsed = PoId.safeParse(input)
  if (!parsed.success) return { ok: false, error: 'Invalid order' }

  const gated = await gate(parsed.data.poId, 'factory.update')
  if (!gated.ok) return { ok: false, error: gated.error }

  return finishManufacturingOrder(createAdminClient(), parsed.data.poId, gated.auth.user.id)
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
  const parsed = PoId.safeParse(input)
  if (!parsed.success) return { ok: false, error: 'Invalid order' }

  const gated = await gate(parsed.data.poId, 'factory.view')
  if (!gated.ok) return { ok: false, error: gated.error }

  const admin = createAdminClient()
  const { data: po } = await admin
    .from('purchase_orders')
    .select('po_number, parent_po_id')
    .eq('id', parsed.data.poId)
    .maybeSingle<{ po_number: string | null; parent_po_id: string | null }>()
  if (!po?.parent_po_id) {
    return { ok: false, error: 'The document for this order is not available. Please contact Echo Barrier.' }
  }

  // The bill of materials hangs off the PARENT order, which is what carries the
  // exploded lines the document is priced from.
  const bom = await loadSroPoBom(po.parent_po_id, admin)
  if (!bom) {
    return { ok: false, error: 'The document for this order is not available. Please contact Echo Barrier.' }
  }

  const supplierRow = await getSupplierByCode('BAMIDA, s.r.o.', admin).catch(() => null)
  const addressLines = (supplierRow?.address ?? '').split('\n').map((l) => l.trim()).filter(Boolean)
  const supplier: BamidaSupplier | undefined =
    supplierRow && addressLines.length
      ? { name: supplierRow.name, address: addressLines, taxNumber: supplierRow.tax_number ?? undefined }
      : undefined

  const document = buildBamidaPo(bom, new Date().toISOString().slice(0, 10), supplier, po.po_number)
  if (document.lines.length === 0) {
    return { ok: false, error: 'The document for this order is not available. Please contact Echo Barrier.' }
  }

  const pdf = await buildBamidaPoPdf(document)
  const bytes = Buffer.from(pdf.output('arraybuffer') as ArrayBuffer)
  // Not bamidaPoPdfFilename: that one starts with the manufacturer's name, and
  // nothing on their side of the Hub carries it.
  return {
    ok: true,
    filename: `Purchase-order-${displayPoNumber(po.po_number)}.pdf`,
    base64: bytes.toString('base64'),
  }
}
