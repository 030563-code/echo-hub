'use server'

/**
 * Rebuild a draft from the deal's CURRENT line items.
 *
 * The one-active-invoice-per-deal index means the old draft must be voided
 * before the new one can be created, so this validates the deal is still
 * invoiceable FIRST and restores the old draft if the create leg fails.
 * Doing it as void-then-create from the client destroyed a fully reviewed
 * draft whenever the create was refused.
 */

import { z } from 'zod'
import { revalidatePath } from 'next/cache'
import { createAdminClient } from '@/lib/supabase/admin'
import { requireInvoicingManage, logInvoiceEvent } from '@/app/actions/invoicing/shared'
import { openInvoiceForDeal } from '@/app/actions/invoicing/open-invoice'

const Input = z.object({ invoiceId: z.string().uuid() })

export type RebuildResult = { success: true; invoiceId: string } | { success: false; error: string }

export async function rebuildInvoiceFromDeal(input: { invoiceId: string }): Promise<RebuildResult> {
  const gate = await requireInvoicingManage()
  if (!gate.ok) return { success: false, error: gate.error }

  const parsed = Input.safeParse(input)
  if (!parsed.success) return { success: false, error: 'Invalid invoice id' }
  const { invoiceId } = parsed.data

  const admin = createAdminClient()
  const { data: invoice } = await admin
    .from('customer_invoices')
    .select('id, status, hubspot_deal_id, is_collection')
    .eq('id', invoiceId)
    .maybeSingle()
  if (!invoice) return { success: false, error: 'Invoice not found.' }
  if (invoice.status !== 'draft' && invoice.status !== 'tax_calculated') {
    return { success: false, error: `Only a draft can be rebuilt (this invoice is ${invoice.status}).` }
  }

  const previousStatus = invoice.status
  const { data: voided, error: voidError } = await admin
    .from('customer_invoices')
    .update({ status: 'voided', updated_by_uid: gate.auth.user.id, updated_at: new Date().toISOString() })
    .eq('id', invoiceId)
    .eq('status', previousStatus)
    .select('id')
  if (voidError || !voided || voided.length === 0) {
    return { success: false, error: 'The invoice changed under you. Refresh and try again.' }
  }

  // Carry the Will Call flag onto the replacement. Losing it here would
  // silently re-tax a collected order at the customer's own address the next
  // time Dave calculated, with nothing on screen to show what changed.
  const opened = await openInvoiceForDeal({
    dealId: invoice.hubspot_deal_id,
    isCollection: invoice.is_collection,
  })
  if (!opened.success) {
    // Put the reviewed draft back exactly as it was: a refused rebuild must
    // never leave the deal with no invoice at all.
    await admin
      .from('customer_invoices')
      .update({ status: previousStatus, updated_at: new Date().toISOString() })
      .eq('id', invoiceId)
      .eq('status', 'voided')
    return { success: false, error: `${opened.error} The existing draft was left untouched.` }
  }

  await logInvoiceEvent(invoiceId, 'voided', gate.auth.user.id, {
    reason: 'rebuilt',
    replaced_by: opened.invoiceId,
    is_collection: invoice.is_collection,
  })
  revalidatePath('/invoicing/accepted')
  revalidatePath('/invoicing/drafts')
  revalidatePath(`/invoicing/${invoice.hubspot_deal_id}`)
  return { success: true, invoiceId: opened.invoiceId }
}
