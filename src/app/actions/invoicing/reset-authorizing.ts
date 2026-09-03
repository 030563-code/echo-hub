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
 *                    authorized. Without this the invoice was frozen forever,
 *                    since every other action refuses on status and the old
 *                    reset refused on the ids being set.
 *  - ids absent   -> nothing was created, or n8n is still mid-flight. After 10
 *                    minutes, release it to tax_calculated so it can be sent
 *                    again (a retry is safe: n8n checks the ids first).
 */

import { z } from 'zod'
import { revalidatePath } from 'next/cache'
import { createAdminClient } from '@/lib/supabase/admin'
import { requireInvoicingManage, logInvoiceEvent } from '@/app/actions/invoicing/shared'

const STUCK_AFTER_MS = 10 * 60 * 1000

const Input = z.object({ invoiceId: z.string().uuid() })

export type ReconcileResult =
  | { success: true; outcome: 'adopted' | 'released'; xeroInvoiceNumber?: string }
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
  if (invoice.status !== 'authorizing' && invoice.status !== 'tax_calculated') {
    return { success: false, error: `Nothing to reconcile: this invoice is ${invoice.status}.` }
  }

  // The invoice landed in Xero; the Hub just never recorded the outcome.
  if (invoice.xero_invoice_id) {
    const now = new Date().toISOString()
    const { data, error } = await admin
      .from('customer_invoices')
      .update({
        status: invoice.emailed_at ? 'sent' : 'authorized',
        authorized_at: now,
        error_message: null,
        updated_by_uid: gate.auth.user.id,
        updated_at: now,
      })
      .eq('id', invoiceId)
      .in('status', ['authorizing', 'tax_calculated'])
      .select('id')
    if (error || !data || data.length === 0) {
      return { success: false, error: 'The invoice changed under you. Refresh and try again.' }
    }
    await logInvoiceEvent(invoiceId, 'authorize_adopted', gate.auth.user.id, {
      xero_invoice_number: invoice.xero_invoice_number,
    })
    revalidatePath(`/invoicing/${invoice.hubspot_deal_id}`)
    revalidatePath('/invoicing/drafts')
    return {
      success: true,
      outcome: 'adopted',
      xeroInvoiceNumber: invoice.xero_invoice_number ?? undefined,
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
