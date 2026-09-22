import 'server-only'

import { serverLogoDataUrl } from '@/lib/pdf-logo.server'
import { createHash } from 'node:crypto'
import { buildInvoiceDocument } from '@/lib/customer-invoice/invoice-document'
import { buildInvoicePdf, invoicePdfFilename } from '@/lib/customer-invoice/invoice-pdf'
import { sellerFor, remittanceFromEnv, remittanceIsIncomplete } from '@/lib/customer-invoice/seller'
import { invoicingProfile } from '@/lib/customer-invoice/invoicing-profile'
import type { CustomerInvoiceRow, CustomerInvoiceLineRow } from './shared'

/**
 * Render one invoice, on the server.
 *
 * Server-side rather than in the browser because the same bytes have to be
 * emailed to the customer and attached to Xero, and bytes that exist only in a
 * tab cannot be either.
 *
 * NOT stored. The render is deterministic given the invoice row, and the row is
 * frozen once it leaves tax_calculated, so re-rendering yields the same
 * document. What IS stored is the sha256 taken at Generate: the email and the
 * Xero attachment re-render and check against it, so a renderer change that
 * would quietly alter an already-issued invoice fails loudly instead of going
 * out. That is the audit property a storage bucket would have bought, without
 * the bucket or the question of who can reach the URL.
 *
 * That reasoning is specific to the PDF and does not extend to attachments. A
 * file a reviewer uploads exists nowhere else and cannot be re-derived, so it
 * IS stored, in the private invoice-attachments bucket, reachable only through
 * a short-lived signed url minted after an invoicing.manage check. See
 * actions/invoicing/attachments.ts.
 */

/** Moved to pdf-logo.server.ts on 16 Sep 2026, unchanged, when the purchase
 *  order PDF needed the same read. One copy of "where the logo lives". */
const logoDataUrl = serverLogoDataUrl

export interface RenderedInvoice {
  bytes: Buffer
  sha256: string
  filename: string
  /** True when the remittance block still carries placeholders, so a caller can
   *  refuse to send a document the customer cannot actually pay from. */
  remittanceIncomplete: boolean
  reference: string
}

export async function renderInvoicePdf(
  invoice: CustomerInvoiceRow,
  lines: CustomerInvoiceLineRow[],
): Promise<RenderedInvoice> {
  // The invoice's own organisation decides the letterhead, the bank details,
  // the tax label and the locale. Never the viewer's, and never a default: a
  // document with the wrong issuer on it is the one thing this must not print.
  const profile = invoicingProfile(invoice.organisation_code)
  if (!profile) {
    throw new Error(`${invoice.organisation_code} does not invoice through the Hub, so its document cannot be rendered.`)
  }
  const seller = sellerFor(profile.org)
  const remittance = remittanceFromEnv(profile.org)
  const document = buildInvoiceDocument(
    {
      invoice_number: invoice.invoice_number,
      holding_reference: invoice.holding_reference,
      invoice_date: invoice.invoice_date,
      due_date: invoice.due_date,
      currency: invoice.currency,
      company_name: invoice.company_name,
      customer_po_number: invoice.customer_po_number,
      delivery_city: invoice.delivery_city,
      delivery_state: invoice.delivery_state,
      delivery_zip: invoice.delivery_zip,
      delivery_street: invoice.delivery_street,
      delivery_country: invoice.delivery_country,
      delivery_location: invoice.delivery_location,
      delivery_requested_by: invoice.delivery_requested_by,
      is_collection: invoice.is_collection,
      billing_name: invoice.billing_name,
      billing_line1: invoice.billing_line1,
      billing_line2: invoice.billing_line2,
      billing_city: invoice.billing_city,
      billing_region: invoice.billing_region,
      billing_postal_code: invoice.billing_postal_code,
      billing_country: invoice.billing_country,
      billing_email: invoice.billing_email,
      subtotal: invoice.subtotal,
      shipping_total: invoice.shipping_total,
      tax_total: invoice.tax_total,
      total: invoice.total,
      taxjar_response: invoice.taxjar_response,
    },
    lines.map((l) => ({
      line_key: l.line_key,
      name: l.name,
      description: l.description,
      quantity: Number(l.quantity),
      unit_price: Number(l.unit_price),
      line_total: Number(l.line_total),
      is_shipping: l.is_shipping,
      ship_from_depot: l.ship_from_depot,
      tax_amount: l.tax_amount === null ? null : Number(l.tax_amount),
      combined_tax_rate: l.combined_tax_rate === null ? null : Number(l.combined_tax_rate),
      sort_order: l.sort_order,
    })),
    { remittance, paymentTerms: invoice.payment_terms_label, taxEngine: profile.taxEngine, taxLabel: profile.taxLabel },
  )

  const pdf = await buildInvoicePdf({
    document,
    sellerLines: seller.addressLines,
    sellerPhone: seller.phone,
    sellerEmail: seller.email,
    legalMentions: seller.legalMentions,
    locale: profile.locale,
    logoDataUrl: await logoDataUrl(),
    // Stable per invoice, never the clock. The invoice date is what the
    // document itself says it was issued on; created_at covers a draft
    // preview, which has no invoice date yet.
    documentId: invoice.id,
    createdAt: new Date(invoice.invoice_date ?? invoice.created_at),
  })

  const bytes = Buffer.from(pdf.output('arraybuffer'))
  return {
    bytes,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    filename: invoicePdfFilename(document.reference),
    remittanceIncomplete: remittanceIsIncomplete(remittance),
    reference: document.reference,
  }
}
