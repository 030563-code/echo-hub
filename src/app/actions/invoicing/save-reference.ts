'use server'

import { z } from 'zod'
import { revalidatePath } from 'next/cache'
import { createAdminClient } from '@/lib/supabase/admin'
import { loadInvoiceWithLines, logInvoiceEvent, requireInvoicingManage } from './shared'

/**
 * Editing the REFERENCE fields on an invoice that TaxJar has already filed.
 *
 * Dean, 2026-09-14: "in /invoicing you should be able still to edit some of the
 * fields after the send to taxjar step like the customer PO reference number
 * etc everything you would need before sending the invoice".
 *
 * Sending to TaxJar files the sale and freezes the invoice, which is right for
 * anything the filing was made against. It is wrong for the three fields a
 * person fills in for the CUSTOMER's benefit, which arrive late (a PO number
 * comes back by email after the order is placed) and which TaxJar has never
 * seen:
 *
 *   - customer_po_number      prints as Reference, and goes to Xero as Reference
 *   - delivery_location       the customer's own name for the yard
 *   - delivery_requested_by   who asked for the delivery
 *
 * None of the three is in `linesHash` (src/lib/customer-invoice/hash.ts), none
 * is part of the TaxJar order (src/app/actions/invoicing/record-taxjar.ts sends
 * the lines, the amounts, the addresses and the date), and none is in the
 * billing snapshot frozen at filing. So changing one cannot make the Hub and
 * the tax filing disagree.
 *
 * They DO print on the document, which the Xero coding fields do not, so this
 * cannot end where saveInvoiceCoding ends. At 'documented' the PDF's sha256 is
 * stored and the email re-renders and compares against it, so a saved change
 * clears that hash and puts the invoice back to 'filed'. The reviewer then
 * presses Generate again and sends a document that matches the record. Failing
 * to do that would not send the wrong PDF, because the hash check refuses, but
 * it would refuse at the moment of sending with no way to tell why.
 *
 * Stops at 'sent'. From there the customer is holding the document, and a
 * reference that disagrees with it is worse than no edit at all.
 */

const Input = z.object({
  invoiceId: z.string().uuid(),
  // Same shapes as the draft save in save-draft.ts, so a field cannot be longer
  // here than it could be before filing.
  customer_po_number: z.string().trim().max(120).nullable(),
  delivery_location: z.string().trim().max(120).nullable(),
  delivery_requested_by: z.string().trim().max(120).nullable(),
})

/**
 * Statuses at which the reference fields may still be changed here.
 *
 * 'filed' and 'documented' only. Before that the normal Save owns the whole
 * header and two writers would fight over the page-state draft; after it the
 * document is with the customer.
 */
const REFERENCE_EDITABLE_STATUSES = new Set(['filed', 'documented'])

export type SaveReferenceResult =
  | { success: true; regenerateNeeded: boolean }
  | { success: false; error: string }

export async function saveInvoiceReference(input: unknown): Promise<SaveReferenceResult> {
  const gate = await requireInvoicingManage()
  if (!gate.ok) return { success: false, error: gate.error }

  const parsed = Input.safeParse(input)
  if (!parsed.success) {
    return { success: false, error: parsed.error.issues[0]?.message ?? 'Invalid invoice reference data' }
  }
  const { invoiceId, customer_po_number, delivery_location, delivery_requested_by } = parsed.data

  const loaded = await loadInvoiceWithLines(invoiceId, gate.auth.profile.organisations)
  if (!loaded.ok) return { success: false, error: loaded.error }
  const { invoice } = loaded

  if (!REFERENCE_EDITABLE_STATUSES.has(invoice.status)) {
    return {
      success: false,
      error:
        invoice.status === 'draft' || invoice.status === 'tax_calculated'
          ? 'This invoice is still editable in full, so use Save.'
          : `This invoice is ${invoice.status}, so its reference fields can no longer be changed.`,
    }
  }

  const next = {
    customer_po_number: customer_po_number || null,
    delivery_location: delivery_location || null,
    delivery_requested_by: delivery_requested_by || null,
  }
  const changed =
    next.customer_po_number !== invoice.customer_po_number ||
    next.delivery_location !== invoice.delivery_location ||
    next.delivery_requested_by !== invoice.delivery_requested_by
  if (!changed) return { success: true, regenerateNeeded: false }

  // A documented invoice goes back to 'filed' with its hash cleared, because
  // the three fields print and the stored hash is what the email trusts.
  const regenerateNeeded = invoice.status === 'documented'
  const admin = createAdminClient()
  const { data, error } = await admin
    .from('customer_invoices')
    .update({
      ...next,
      ...(regenerateNeeded ? { status: 'filed', pdf_sha256: null } : {}),
      updated_by_uid: gate.auth.user.id,
      updated_at: new Date().toISOString(),
    })
    .eq('id', invoiceId)
    // The status is re-tested in the write itself: between the read above and
    // here, someone else could have generated, sent or voided this invoice.
    .in('status', ['filed', 'documented'])
    .select('id')

  if (error) {
    console.error('saveInvoiceReference update failed', { invoiceId, error: error.message })
    return { success: false, error: 'Could not save the reference fields. Please try again.' }
  }
  if (!data || data.length === 0) {
    return { success: false, error: 'This invoice moved on while you were editing. Reload the page and try again.' }
  }

  await logInvoiceEvent(invoiceId, 'reference_edited', gate.auth.user.id, {
    from: {
      customer_po_number: invoice.customer_po_number,
      delivery_location: invoice.delivery_location,
      delivery_requested_by: invoice.delivery_requested_by,
    },
    to: next,
    regenerate_needed: regenerateNeeded,
  })

  revalidatePath(`/invoicing/${invoice.hubspot_deal_id}`)
  revalidatePath('/invoicing/filed')
  revalidatePath('/invoicing/documented')
  return { success: true, regenerateNeeded }
}
