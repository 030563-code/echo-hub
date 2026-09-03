'use server'

/**
 * Render the invoice for review, changing nothing.
 *
 * Dean asked for a preview BEFORE Send to TaxJar, which is the step that
 * allocates the EBUS number. Nothing here advances the invoice: no status, no
 * number, nothing filed, nothing sent. Run it as often as you like.
 *
 * The one thing it does write is the bill-to snapshot, and only when the
 * invoice has none yet. Without it the document falls back to the company name
 * off the account registry, which is how an invoice ends up showing a bare
 * "Apex" where the customer's actual billing address belongs. Capturing it is
 * not a state change, and taking it here means the preview shows exactly what
 * the issued invoice will show.
 *
 * Before the number exists the document titles itself "Draft invoice", says
 * "NOT AN INVOICE, preview only", and falls back to the internal holding
 * reference. Reviewing something that looks issued but is not is the mistake
 * this step exists to prevent, so the document has to say which it is.
 */

import { z } from 'zod'
import { xeroFindContact } from '@/lib/xero-hub'
import { requireInvoicingManage, loadInvoiceWithLines, snapshotBillingContact } from './shared'
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

  // No bill-to captured yet: fetch the Xero contact once and freeze it, so the
  // preview and every later render agree.
  let current = invoice
  if (!invoice.billing_snapshot_at && invoice.taxjar_customer_id) {
    const contact = await xeroFindContact(invoice.taxjar_customer_id)
    if (contact.ok && contact.data) {
      await snapshotBillingContact(invoice.id, contact.data)
      current = {
        ...invoice,
        billing_name: contact.data.name,
        billing_email: contact.data.email,
        billing_line1: contact.data.address?.line1 ?? null,
        billing_line2: contact.data.address?.line2 ?? null,
        billing_city: contact.data.address?.city ?? null,
        billing_region: contact.data.address?.region ?? null,
        billing_postal_code: contact.data.address?.postal_code ?? null,
        billing_country: contact.data.address?.country ?? null,
        billing_snapshot_at: new Date().toISOString(),
      }
    }
    // A Xero outage must not block a preview. The document falls back to the
    // company name and the rep can still check the lines and the tax.
  }

  try {
    const rendered = await renderInvoicePdf(current, lines)
    return {
      success: true,
      pdfBase64: rendered.bytes.toString('base64'),
      filename: rendered.filename,
      isDraft: current.invoice_number === null,
      remittanceIncomplete: rendered.remittanceIncomplete,
    }
  } catch (error) {
    console.error('previewInvoicePdf failed', error)
    return { success: false, error: 'The invoice could not be rendered. The error is in the server log.' }
  }
}
