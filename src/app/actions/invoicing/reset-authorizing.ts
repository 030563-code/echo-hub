'use server'

/**
 * Recovery for an invoice stuck in `authorizing` (server died mid-webhook).
 * Only allowed once the row has sat there for 10+ minutes, and only rolls
 * back to tax_calculated so the reviewer can retry. Safe: n8n's idempotency
 * check means a retry can never double-create the Xero invoice, and if Xero
 * DID create it, the retry returns the existing ids.
 */

import { z } from 'zod'
import { revalidatePath } from 'next/cache'
import { createAdminClient } from '@/lib/supabase/admin'
import { requireInvoicingManage, logInvoiceEvent } from '@/app/actions/invoicing/shared'

const STUCK_AFTER_MS = 10 * 60 * 1000

const Input = z.object({ invoiceId: z.string().uuid() })

export type ResetAuthorizingResult = { success: true } | { success: false; error: string }

export async function resetStuckAuthorizing(input: { invoiceId: string }): Promise<ResetAuthorizingResult> {
  const gate = await requireInvoicingManage()
  if (!gate.ok) return { success: false, error: gate.error }

  const parsed = Input.safeParse(input)
  if (!parsed.success) return { success: false, error: 'Invalid invoice id' }
  const { invoiceId } = parsed.data

  const admin = createAdminClient()
  const { data: invoice } = await admin
    .from('customer_invoices')
    .select('status, updated_at, hubspot_deal_id, xero_invoice_id')
    .eq('id', invoiceId)
    .maybeSingle()
  if (!invoice) return { success: false, error: 'Invoice not found.' }
  if (invoice.status !== 'authorizing') return { success: false, error: 'This invoice is not stuck sending.' }
  if (Date.now() - new Date(invoice.updated_at).getTime() < STUCK_AFTER_MS) {
    return { success: false, error: 'Still sending. Wait 10 minutes before forcing a retry.' }
  }
  if (invoice.xero_invoice_id) {
    return { success: false, error: 'Xero ids already landed on this invoice. Refresh instead of resetting.' }
  }

  const { data, error } = await admin
    .from('customer_invoices')
    .update({ status: 'tax_calculated', updated_by_uid: gate.auth.user.id, updated_at: new Date().toISOString() })
    .eq('id', invoiceId)
    .eq('status', 'authorizing')
    .select('id')
  if (error || !data || data.length === 0) {
    return { success: false, error: 'The invoice changed under you. Refresh and try again.' }
  }

  await logInvoiceEvent(invoiceId, 'authorize_reset', gate.auth.user.id)
  revalidatePath(`/invoicing/${invoice.hubspot_deal_id}`)
  revalidatePath('/invoicing/drafts')
  return { success: true }
}
