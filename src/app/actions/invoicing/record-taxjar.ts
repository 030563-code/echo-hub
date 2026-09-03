'use server'

/**
 * File the invoice into TaxJar as an order transaction. This is the "Send to
 * TaxJar" action, and it is the ONLY place an order transaction is created:
 * calculating tax (/v2/taxes) files nothing, and drafting into Xero files
 * nothing either. Safe to repeat: TaxJar duplicates return 422 and are updated
 * via PUT.
 */

import { z } from 'zod'
import { revalidatePath } from 'next/cache'
import { createAdminClient } from '@/lib/supabase/admin'
import {
  requireInvoicingManage,
  loadInvoiceWithLines,
  logInvoiceEvent,
  recordTaxJarOrders,
} from '@/app/actions/invoicing/shared'

const Input = z.object({ invoiceId: z.string().uuid() })

export type RecordTaxJarResult = { success: true } | { success: false; error: string }

export async function retryTaxJarRecord(input: { invoiceId: string }): Promise<RecordTaxJarResult> {
  const gate = await requireInvoicingManage()
  if (!gate.ok) return { success: false, error: gate.error }

  const parsed = Input.safeParse(input)
  if (!parsed.success) return { success: false, error: 'Invalid invoice id' }
  const { invoiceId } = parsed.data

  const loaded = await loadInvoiceWithLines(invoiceId)
  if (!loaded.ok) return { success: false, error: loaded.error }
  const { invoice, lines } = loaded

  // `raised` is the state the Hub now lands on: the number is allocated and the
  // Xero DRAFT exists. That is the earliest point at which a sale can honestly
  // be filed, because the filing is keyed on the invoice number.
  if (invoice.status !== 'raised' && invoice.status !== 'authorized' && invoice.status !== 'sent') {
    return {
      success: false,
      error: `Only an invoice that has been sent to Xero can be filed to TaxJar (this one is ${invoice.status}).`,
    }
  }

  if (!invoice.invoice_number) {
    return { success: false, error: 'This invoice has no number yet, so it cannot be filed to TaxJar.' }
  }
  const recorded = await recordTaxJarOrders(invoice, lines, invoice.invoice_number)
  if (!recorded.ok) {
    await logInvoiceEvent(invoiceId, 'taxjar_record_failed', gate.auth.user.id, { error: recorded.error })
    return { success: false, error: `Recording in TaxJar failed: ${recorded.error}` }
  }

  const admin = createAdminClient()
  await admin
    .from('customer_invoices')
    .update({
      taxjar_transaction_id: recorded.transactionIds.join(','),
      taxjar_transaction_recorded_at: new Date().toISOString(),
      status: 'completed',
      updated_by_uid: gate.auth.user.id,
      updated_at: new Date().toISOString(),
    })
    .eq('id', invoiceId)
    .in('status', ['raised', 'authorized', 'sent'])
  await logInvoiceEvent(invoiceId, 'taxjar_recorded', gate.auth.user.id, { transaction_ids: recorded.transactionIds })

  revalidatePath('/invoicing/drafts')
  revalidatePath(`/invoicing/${invoice.hubspot_deal_id}`)
  return { success: true }
}
