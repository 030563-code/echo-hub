'use server'

/**
 * Number the invoice: the French counterpart of Send to TaxJar.
 *
 * record-taxjar.ts does three things in order: stamps the dates and terms and
 * freezes the bill-to, allocates the gapless number, and files the sale with
 * TaxJar. France keeps the first two and has no third: nothing is filed
 * anywhere, because the authorised Xero invoice at the end of the ladder is the
 * record. So this is where a French invoice stops being a draft and takes its
 * number, and it moves `tax_calculated -> filed` so the rest of the ladder
 * (generate, email, send to Xero) is exactly the USA's.
 *
 * 🔴 The Xero draft is left alone here. It still carries the holding reference
 * as its InvoiceNumber; the authorise leg rewrites that to the real number on
 * the same InvoiceID in the same call that sets AUTHORISED. Two writes to Xero
 * where one will do is a second place for the two records to disagree.
 *
 * Safe to repeat: raise_customer_invoice hands back the existing number rather
 * than allocating a second.
 */

import { z } from 'zod'
import { revalidatePath } from 'next/cache'
import { createAdminClient } from '@/lib/supabase/admin'
import { xeroFindContact } from '@/lib/xero-hub'
import { invoicingProfile } from '@/lib/customer-invoice/invoicing-profile'
import { dueDateFromTerms, describeTerms } from '@/lib/customer-invoice/payment-terms'
import { orgLabel } from '@/lib/organisations'
import {
  requireInvoicingManage,
  loadInvoiceWithLines,
  logInvoiceEvent,
  snapshotBillingContact,
} from '@/app/actions/invoicing/shared'

const Input = z.object({ invoiceId: z.string().uuid() })

export type FileInvoiceResult =
  | { success: true; invoiceNumber: string; warnings: string[] }
  | { success: false; error: string }

export async function fileInvoiceXeroDraft(input: { invoiceId: string }): Promise<FileInvoiceResult> {
  const gate = await requireInvoicingManage()
  if (!gate.ok) return { success: false, error: gate.error }

  const parsed = Input.safeParse(input)
  if (!parsed.success) return { success: false, error: 'Invalid invoice id' }
  const { invoiceId } = parsed.data

  const loaded = await loadInvoiceWithLines(invoiceId, gate.auth.profile.organisations)
  if (!loaded.ok) return { success: false, error: loaded.error }
  const { invoice } = loaded

  const profile = invoicingProfile(invoice.organisation_code)
  if (!profile || profile.taxEngine !== 'xero_draft') {
    return { success: false, error: `${orgLabel(invoice.organisation_code)} files through TaxJar, not this step.` }
  }
  // Numbering follows the Xero draft, and an organisation with no Xero leg has
  // no draft to follow. Refused before a number could be taken.
  if (profile.xeroNotConnected) return { success: false, error: profile.xeroNotConnected }

  // `filed` is allowed so a failure after the number was taken can be retried
  // without allocating a second one.
  if (invoice.status !== 'tax_calculated' && invoice.status !== 'filed') {
    return { success: false, error: `Only an invoice with calculated tax can be numbered (this one is ${invoice.status}).` }
  }
  // The tax came from a Xero draft; an invoice with none has not really been
  // priced, whatever its status says.
  if (!invoice.xero_draft_invoice_id) {
    return { success: false, error: 'This invoice has no Xero draft behind its tax. Save and calculate tax again first.' }
  }

  const admin = createAdminClient()
  const warnings: string[] = []

  // --- 1. Dates and terms, and the bill-to frozen with them ---
  const today = new Date().toISOString().slice(0, 10)
  const invoiceDate = invoice.invoice_date ?? today
  let dueDate = invoice.due_date
  let termsLabel = invoice.payment_terms_label

  if (!dueDate || !termsLabel || !invoice.billing_snapshot_at) {
    const contact = invoice.taxjar_customer_id ? await xeroFindContact(profile.org, invoice.taxjar_customer_id) : null
    const terms = contact && contact.ok && contact.data ? contact.data.payment_terms : null
    if (contact && contact.ok && contact.data) await snapshotBillingContact(invoiceId, contact.data)
    dueDate = dueDate ?? dueDateFromTerms(invoiceDate, terms)
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
      if (message.includes('NO_INVOICE_SERIES')) {
        return { success: false, error: `${orgLabel(profile.org)} has no invoice number series yet.` }
      }
      console.error('raise_customer_invoice failed', error)
      return { success: false, error: 'The invoice number could not be allocated.' }
    }
    invoiceNumber = String((data as { invoice_number?: string } | null)?.invoice_number ?? '')
    if (!invoiceNumber) return { success: false, error: 'The invoice number could not be allocated.' }
  }

  // --- 3. Committed. No filing: there is nothing to file. ---
  await admin
    .from('customer_invoices')
    .update({
      status: 'filed',
      updated_by_uid: gate.auth.user.id,
      updated_at: new Date().toISOString(),
    })
    .eq('id', invoiceId)
    .in('status', ['tax_calculated', 'filed'])

  await logInvoiceEvent(invoiceId, 'numbered', gate.auth.user.id, {
    invoice_number: invoiceNumber,
    engine: 'xero_draft',
    xero_draft_invoice_id: invoice.xero_draft_invoice_id,
  })

  revalidatePath('/invoicing/tax-calculated')
  revalidatePath('/invoicing/filed')
  revalidatePath(`/invoicing/${invoice.hubspot_deal_id}`)
  return { success: true, invoiceNumber, warnings }
}
