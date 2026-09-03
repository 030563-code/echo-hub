'use server'

/**
 * Generate the invoice PDF: step 3 of the pipeline.
 *
 * The document is not stored. It is deterministic given the invoice row, and
 * the row is frozen from tax_calculated onwards, so re-rendering produces the
 * same bytes. What IS stored is the sha256 taken here. The email and the Xero
 * attachment re-render and check against it, so a renderer change that would
 * quietly alter an already-issued invoice fails loudly rather than going out to
 * a customer. That is the audit property, without a storage bucket and without
 * the question of who can reach its URL.
 */

import { z } from 'zod'
import { revalidatePath } from 'next/cache'
import { createAdminClient } from '@/lib/supabase/admin'
import { requireInvoicingManage, loadInvoiceWithLines, logInvoiceEvent } from './shared'
import { renderInvoicePdf } from './document-data'

const Input = z.object({ invoiceId: z.string().uuid() })

export type GenerateInvoicePdfResult =
  | { success: true; pdfBase64: string; filename: string; warnings: string[] }
  | { success: false; error: string }

export async function generateInvoicePdf(input: { invoiceId: string }): Promise<GenerateInvoicePdfResult> {
  const gate = await requireInvoicingManage()
  if (!gate.ok) return { success: false, error: gate.error }

  const parsed = Input.safeParse(input)
  if (!parsed.success) return { success: false, error: 'Invalid invoice id' }

  const loaded = await loadInvoiceWithLines(parsed.data.invoiceId)
  if (!loaded.ok) return { success: false, error: loaded.error }
  const { invoice, lines } = loaded

  // `documented` is allowed so the document can be regenerated before it goes
  // anywhere. Once it has been emailed it must not be regenerated: the customer
  // is holding the old one.
  if (invoice.status !== 'filed' && invoice.status !== 'documented') {
    return {
      success: false,
      error: `The invoice has to be filed with TaxJar before its document is generated (this one is ${invoice.status}).`,
    }
  }
  if (!invoice.invoice_number) {
    return { success: false, error: 'This invoice has no number yet, so its document cannot be generated.' }
  }

  let rendered
  try {
    rendered = await renderInvoicePdf(invoice, lines)
  } catch (error) {
    console.error('generateInvoicePdf failed', error)
    return { success: false, error: 'The invoice could not be rendered. The error is in the server log.' }
  }

  const warnings: string[] = []
  if (rendered.remittanceIncomplete) {
    // Not a refusal. A rep may legitimately want the document to check it, and
    // the placeholders are printed in a colour that makes the gap obvious.
    warnings.push(
      'The bank details are not configured, so the document shows placeholders where the payment instructions go. Do not send it to the customer like this.',
    )
  }

  const admin = createAdminClient()
  await admin
    .from('customer_invoices')
    .update({
      pdf_generated_at: new Date().toISOString(),
      pdf_sha256: rendered.sha256,
      status: 'documented',
      updated_by_uid: gate.auth.user.id,
      updated_at: new Date().toISOString(),
    })
    .eq('id', parsed.data.invoiceId)
    .in('status', ['filed', 'documented'])

  await logInvoiceEvent(parsed.data.invoiceId, 'pdf_generated', gate.auth.user.id, {
    sha256: rendered.sha256,
    remittance_incomplete: rendered.remittanceIncomplete,
  })

  revalidatePath('/invoicing/filed')
  revalidatePath('/invoicing/documented')
  revalidatePath(`/invoicing/${invoice.hubspot_deal_id}`)
  return { success: true, pdfBase64: rendered.bytes.toString('base64'), filename: rendered.filename, warnings }
}
