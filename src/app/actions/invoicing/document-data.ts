import 'server-only'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { buildInvoiceDocument } from '@/lib/customer-invoice/invoice-document'
import { buildInvoicePdf, invoicePdfFilename } from '@/lib/customer-invoice/invoice-pdf'
import { SELLER_ADDRESS_LINES, SELLER_PHONE, remittanceFromEnv } from '@/lib/customer-invoice/seller'
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
 */

let logoCache: string | null | undefined

/** The wordmark, read once off disk. `undefined` means not tried yet, `null`
 *  means tried and failed, and a failure must cost the logo rather than the
 *  invoice. */
async function logoDataUrl(): Promise<string | undefined> {
  if (logoCache !== undefined) return logoCache ?? undefined
  try {
    const bytes = await readFile(path.join(process.cwd(), 'public', 'logo.jpg'))
    logoCache = `data:image/jpeg;base64,${bytes.toString('base64')}`
  } catch (error) {
    console.error('Invoice PDF: logo could not be read from public/logo.jpg', error)
    logoCache = null
  }
  return logoCache ?? undefined
}

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
  const remittance = remittanceFromEnv()
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
      is_collection: invoice.is_collection,
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
      ship_from_depot: l.ship_from_depot as 'US-BAL' | 'US-SBD',
      tax_amount: l.tax_amount === null ? null : Number(l.tax_amount),
      combined_tax_rate: l.combined_tax_rate === null ? null : Number(l.combined_tax_rate),
      sort_order: l.sort_order,
    })),
    { remittance, paymentTerms: invoice.payment_terms_label },
  )

  const pdf = await buildInvoicePdf({
    document,
    sellerLines: SELLER_ADDRESS_LINES,
    sellerPhone: SELLER_PHONE,
    logoDataUrl: await logoDataUrl(),
  })

  const bytes = Buffer.from(pdf.output('arraybuffer'))
  return {
    bytes,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    filename: invoicePdfFilename(document.reference),
    remittanceIncomplete:
      remittance.bankName === null || remittance.achRouting === null || remittance.accountNumber === null,
    reference: document.reference,
  }
}
