'use server'

/**
 * Render the invoice for review, changing nothing.
 *
 * Dean asked for a preview BEFORE Send to TaxJar, which is the step that
 * allocates the EBUS number. So this deliberately writes nothing at all: no
 * status, no number, no timestamp. Run it as often as you like.
 *
 * Before the number exists the document titles itself "Draft invoice", says
 * "NOT AN INVOICE, preview only", and falls back to the internal holding
 * reference. Reviewing something that looks issued but is not is the mistake
 * this step exists to prevent, so the document has to say which it is.
 */

import { z } from 'zod'
import { requireInvoicingManage, loadInvoiceWithLines } from './shared'
import { renderInvoicePdf } from './document-data'

const Input = z.object({ invoiceId: z.string().uuid() })

export type PreviewInvoiceResult =
  | { success: true; pdfBase64: string; filename: string; isDraft: boolean; remittanceIncomplete: boolean }
  | { success: false; error: string }

export async function previewInvoicePdf(input: { invoiceId: string }): Promise<PreviewInvoiceResult> {
  const gate = await requireInvoicingManage()
  if (!gate.ok) return { success: false, error: gate.error }

  const parsed = Input.safeParse(input)
  if (!parsed.success) return { success: false, error: 'Invalid invoice id' }

  const loaded = await loadInvoiceWithLines(parsed.data.invoiceId)
  if (!loaded.ok) return { success: false, error: loaded.error }
  const { invoice, lines } = loaded

  if (invoice.status === 'voided') {
    return { success: false, error: 'This invoice was discarded, so there is nothing to preview.' }
  }
  if (lines.length === 0) {
    return { success: false, error: 'This invoice has no lines yet, so there is nothing to preview.' }
  }

  try {
    const rendered = await renderInvoicePdf(invoice, lines)
    return {
      success: true,
      pdfBase64: rendered.bytes.toString('base64'),
      filename: rendered.filename,
      isDraft: invoice.invoice_number === null,
      remittanceIncomplete: rendered.remittanceIncomplete,
    }
  } catch (error) {
    console.error('previewInvoicePdf failed', error)
    return { success: false, error: 'The invoice could not be rendered. The error is in the server log.' }
  }
}
