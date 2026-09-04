'use server'

/**
 * Recovery for an invoice the Hub stopped tracking mid-send: the server died
 * during the webhook call, or Xero answered after our 30s timeout.
 *
 * There are exactly two states to recover, and which one applies is decided by
 * whether n8n wrote the Xero ids back (it does that itself, immediately after
 * creating the invoice, precisely so this is knowable):
 *
 *  - ids present  -> the invoice EXISTS in Xero. Adopt it: move the Hub to
 *                    completed and close the deal won, the same end state the
 *                    happy path reaches. Without this the invoice was frozen
 *                    forever, since every other action refuses on status and
 *                    the old reset refused on the ids being set.
 *  - ids absent   -> nothing was created, or n8n is still mid-flight. After 10
 *                    minutes, release it to tax_calculated so it can be sent
 *                    again (a retry is safe: n8n checks the ids first).
 */

import { z } from 'zod'
import { revalidatePath } from 'next/cache'
import { createAdminClient } from '@/lib/supabase/admin'
import { requireInvoicingManage, logInvoiceEvent } from '@/app/actions/invoicing/shared'
import { closeDealWon } from '@/app/actions/hubspot/closeDealWon'

const STUCK_AFTER_MS = 10 * 60 * 1000

const Input = z.object({ invoiceId: z.string().uuid() })

export type ReconcileResult =
  | { success: true; outcome: 'adopted' | 'released'; xeroInvoiceNumber?: string; dealWarning?: string }
  | { success: false; error: string }

export async function reconcileStuckInvoice(input: { invoiceId: string }): Promise<ReconcileResult> {
  const gate = await requireInvoicingManage()
  if (!gate.ok) return { success: false, error: gate.error }

  const parsed = Input.safeParse(input)
  if (!parsed.success) return { success: false, error: 'Invalid invoice id' }
  const { invoiceId } = parsed.data

  const admin = createAdminClient()
  const { data: invoice } = await admin
    .from('customer_invoices')
    .select('status, updated_at, hubspot_deal_id, xero_invoice_id, xero_invoice_number, emailed_at')
    .eq('id', invoiceId)
    .maybeSingle()
  if (!invoice) return { success: false, error: 'Invoice not found.' }
  // `sent` is here because that is where a send whose outcome was misread ends
  // up. It is also the state EBUS26-0001 was frozen in: in Xero, ids written
  // back, but refused by Send (the ids are set) AND by Reconcile (the status
  // was not one of these two). Nothing could move it.
  if (!['authorizing', 'tax_calculated', 'sent'].includes(invoice.status)) {
    return { success: false, error: `Nothing to reconcile: this invoice is ${invoice.status}.` }
  }

  // The invoice landed in Xero; the Hub just never recorded the outcome.
  if (invoice.xero_invoice_id) {
    const now = new Date().toISOString()
    const { data, error } = await admin
      .from('customer_invoices')
      .update({
        // `completed` is the end of the line, and the invoice IS in Xero.
        //
        // This used to adopt to `sent` when the invoice had been emailed, which
        // is precisely the state a misread send leaves it in, so adopting was a
        // no-op that re-froze it. The other branch, `authorized`, is legacy and
        // no longer written anywhere.
        status: 'completed',
        authorized_at: now,
        error_message: null,
        updated_by_uid: gate.auth.user.id,
        updated_at: now,
      })
      .eq('id', invoiceId)
      .in('status', ['authorizing', 'tax_calculated', 'sent'])
      .select('id')
    if (error || !data || data.length === 0) {
      return { success: false, error: 'The invoice changed under you. Refresh and try again.' }
    }
    await logInvoiceEvent(invoiceId, 'authorize_adopted', gate.auth.user.id, {
      xero_invoice_number: invoice.xero_invoice_number,
      // Adoption proves the INVOICE reached Xero, because n8n writes the ids
      // straight after creating it. It proves nothing about the PDF, which is
      // attached later in the same run and is exactly the step that tends to
      // have failed when a run ends without answering.
      pdf_attachment_confirmed: false,
    })
    // The deal is closed won on the happy path once the invoice is completed.
    // An adopted invoice reached the same place by a worse route, so it gets
    // the same treatment. Best effort: never let this undo the row above, but
    // the result is REPORTED rather than discarded. Swallowing it is how a
    // close that silently did nothing looked like a close that worked.
    const closedWon = await closeDealWon(invoice.hubspot_deal_id)
    revalidatePath(`/invoicing/${invoice.hubspot_deal_id}`)
    revalidatePath('/invoicing/drafts')
    revalidatePath('/invoicing/sent')
    revalidatePath('/invoicing/completed')
    return {
      success: true,
      outcome: 'adopted',
      xeroInvoiceNumber: invoice.xero_invoice_number ?? undefined,
      dealWarning: closedWon.success
        ? undefined
        : `The HubSpot deal could not be moved to Closed won (${closedWon.error}). Move it by hand.`,
    }
  }

  if (invoice.status !== 'authorizing') {
    return { success: false, error: 'Nothing to reconcile: this invoice is not stuck sending.' }
  }
  if (Date.now() - new Date(invoice.updated_at).getTime() < STUCK_AFTER_MS) {
    return { success: false, error: 'Still sending. Wait 10 minutes before forcing a retry.' }
  }

  const { data, error } = await admin
    .from('customer_invoices')
    .update({ status: 'tax_calculated', updated_by_uid: gate.auth.user.id, updated_at: new Date().toISOString() })
    .eq('id', invoiceId)
    .eq('status', 'authorizing')
    // Part of the same compare-and-set: if n8n wrote the ids back between the
    // read above and this update, releasing would risk a duplicate invoice.
    .is('xero_invoice_id', null)
    .select('id')
  if (error || !data || data.length === 0) {
    return { success: false, error: 'The invoice changed under you (it may have just landed in Xero). Refresh and try again.' }
  }

  await logInvoiceEvent(invoiceId, 'authorize_reset', gate.auth.user.id)
  revalidatePath(`/invoicing/${invoice.hubspot_deal_id}`)
  revalidatePath('/invoicing/drafts')
  return { success: true, outcome: 'released' }
}
