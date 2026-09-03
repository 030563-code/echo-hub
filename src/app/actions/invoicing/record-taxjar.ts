'use server'

/**
 * Send to TaxJar: allocate the EBUS number, then file the sale.
 *
 * This is step 2 of the reordered pipeline (Dean, 2026-09-03) and it is where
 * the invoice stops being a draft. Three things happen together, in this order,
 * because each depends on the one before:
 *
 * 1. The invoice date is stamped. TaxJar files against it, and leaving it null
 *    would file the sale under today's date instead of the invoice's.
 * 2. The EBUS number is allocated, gaplessly. The filing is keyed on it.
 * 3. The order transaction is created, one per shipment.
 *
 * The number moves here from Send to Xero, which is now the last step. Filing
 * is the first thing that commits anything outward, so it is the honest place
 * to stop using a holding reference. An abandoned draft still burns nothing.
 *
 * Safe to repeat: raise_customer_invoice hands back the existing number rather
 * than allocating a second, and TaxJar duplicates are updated via PUT.
 */

import { z } from 'zod'
import { revalidatePath } from 'next/cache'
import { createAdminClient } from '@/lib/supabase/admin'
import { xeroFindContact } from '@/lib/xero-hub'
import { dueDateFromTerms, describeTerms } from '@/lib/customer-invoice/payment-terms'
import {
  requireInvoicingManage,
  loadInvoiceWithLines,
  logInvoiceEvent,
  recordTaxJarOrders,
  snapshotBillingContact,
} from '@/app/actions/invoicing/shared'

const Input = z.object({ invoiceId: z.string().uuid() })

export type RecordTaxJarResult =
  | { success: true; invoiceNumber: string; transactionIds: string[]; warnings: string[] }
  | { success: false; error: string }

export async function sendOrderToTaxJar(input: { invoiceId: string }): Promise<RecordTaxJarResult> {
  const gate = await requireInvoicingManage()
  if (!gate.ok) return { success: false, error: gate.error }

  const parsed = Input.safeParse(input)
  if (!parsed.success) return { success: false, error: 'Invalid invoice id' }
  const { invoiceId } = parsed.data

  const loaded = await loadInvoiceWithLines(invoiceId)
  if (!loaded.ok) return { success: false, error: loaded.error }
  const { invoice, lines } = loaded

  // `filed` is allowed so a failed filing can be retried without the number
  // being allocated twice.
  if (invoice.status !== 'tax_calculated' && invoice.status !== 'filed') {
    return {
      success: false,
      error: `Only an invoice with calculated tax can be sent to TaxJar (this one is ${invoice.status}).`,
    }
  }

  const admin = createAdminClient()
  const warnings: string[] = []

  // --- 1. Dates and terms, stamped before anything is filed ---
  // TaxJar files against invoice_date. Leaving it null files the sale under
  // today's date instead, which is only invisible until a period closes.
  const today = new Date().toISOString().slice(0, 10)
  let invoiceDate = invoice.invoice_date ?? today
  let dueDate = invoice.due_date
  let termsLabel = invoice.payment_terms_label

  if (!dueDate || !termsLabel || !invoice.billing_snapshot_at) {
    const contact = invoice.taxjar_customer_id ? await xeroFindContact(invoice.taxjar_customer_id) : null
    const terms = contact && contact.ok && contact.data ? contact.data.payment_terms : null
    // The bill-to block is frozen here too, in the same lookup. From this point
    // the invoice prints from its own copy, so an edit in Xero afterwards
    // cannot change what an issued document says.
    if (contact && contact.ok && contact.data) await snapshotBillingContact(invoiceId, contact.data)
    dueDate = dueDate ?? dueDateFromTerms(invoiceDate, terms)
    // Snapshotted as WORDS as well as a date. Re-deriving it from Xero at print
    // time would let an edit there change the terms on an issued invoice.
    termsLabel = termsLabel ?? describeTerms(terms)
    if (!contact || !contact.ok) {
      warnings.push('Xero could not be reached for the payment terms, so the house default of Net 30 was used.')
    }
  }

  if (invoice.invoice_date !== invoiceDate || invoice.due_date !== dueDate || invoice.payment_terms_label !== termsLabel) {
    await admin
      .from('customer_invoices')
      .update({ invoice_date: invoiceDate, due_date: dueDate, payment_terms_label: termsLabel })
      .eq('id', invoiceId)
    invoiceDate = invoiceDate
  }

  // --- 2. The number ---
  let invoiceNumber = invoice.invoice_number
  if (!invoiceNumber) {
    const { data, error } = await admin.rpc('raise_customer_invoice', {
      p_invoice_id: invoiceId,
      p_expected_hash: invoice.lines_hash,
      p_actor: gate.auth.user.id,
    })
    if (error) {
      const message = String(error.message ?? '')
      if (message.includes('STALE_CALCULATION')) {
        return { success: false, error: 'The lines changed after the tax was calculated. Save the draft again first.' }
      }
      if (message.includes('INVALID_STATUS')) {
        return { success: false, error: 'This invoice is no longer in a state that can be numbered.' }
      }
      console.error('raise_customer_invoice failed', error)
      return { success: false, error: 'The invoice number could not be allocated.' }
    }
    invoiceNumber = String((data as { invoice_number?: string } | null)?.invoice_number ?? '')
    if (!invoiceNumber) return { success: false, error: 'The invoice number could not be allocated.' }
  }

  // --- 3. The filing ---
  const recorded = await recordTaxJarOrders({ ...invoice, invoice_date: invoiceDate }, lines, invoiceNumber)
  if (!recorded.ok) {
    await logInvoiceEvent(invoiceId, 'taxjar_record_failed', gate.auth.user.id, { error: recorded.error })
    // The number stays allocated on purpose. It is gapless, so handing it back
    // would leave a hole; and a retry must file under the SAME number, not a
    // new one, or TaxJar ends up holding two transactions for one sale.
    return { success: false, error: `Filing to TaxJar failed: ${recorded.error}. The number ${invoiceNumber} is held for the retry.` }
  }

  await admin
    .from('customer_invoices')
    .update({
      taxjar_transaction_id: recorded.transactionIds.join(','),
      taxjar_transaction_recorded_at: new Date().toISOString(),
      status: 'filed',
      updated_by_uid: gate.auth.user.id,
      updated_at: new Date().toISOString(),
    })
    .eq('id', invoiceId)
    .in('status', ['tax_calculated', 'filed'])

  await logInvoiceEvent(invoiceId, 'taxjar_recorded', gate.auth.user.id, {
    invoice_number: invoiceNumber,
    transaction_ids: recorded.transactionIds,
  })

  revalidatePath('/invoicing/tax-calculated')
  revalidatePath('/invoicing/filed')
  revalidatePath(`/invoicing/${invoice.hubspot_deal_id}`)
  return { success: true, invoiceNumber, transactionIds: recorded.transactionIds, warnings }
}
