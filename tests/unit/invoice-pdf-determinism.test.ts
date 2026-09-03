import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import { buildInvoiceDocument, type InvoiceDocumentHeaderRow, type InvoiceDocumentLineRow } from '@/lib/customer-invoice/invoice-document'
import { buildInvoicePdf } from '@/lib/customer-invoice/invoice-pdf'
import { SELLER_ADDRESS_LINES } from '@/lib/customer-invoice/seller'
import type { RemittanceDetails } from '@/lib/customer-invoice/seller'

/**
 * THE INVOICING FLOW DEPENDS ON THIS.
 *
 * Generate hashes the rendered PDF; Email re-renders and refuses to send if the
 * bytes differ, so a customer can only ever receive the document that was
 * checked. That comparison is worthless unless identical data renders identical
 * bytes.
 *
 * jsPDF does not give you that for free. It stamps a wall-clock /CreationDate
 * and a RANDOM /ID into every document, which made the check unpassable: every
 * Email attempt failed, whatever you did, because no two renders ever matched.
 * buildInvoicePdf now pins both from the invoice id and a date on the row.
 *
 * If this test ever fails, emailing an invoice is broken for everyone.
 */

const REMIT: RemittanceDetails = {
  accountName: 'Echo Barrier USA LLC',
  bankName: 'A Bank',
  bankAddress: ['1 Bank St', 'New York'],
  routingNumber: '000000000',
  accountNumber: '111111111',
  ein: null,
}

const header: InvoiceDocumentHeaderRow = {
  invoice_number: 'EBUS26-0001', holding_reference: 'USI2026-00010',
  invoice_date: '2026-09-03', due_date: '2026-10-03', currency: 'USD',
  company_name: 'Apex', customer_po_number: '11304',
  delivery_city: 'Los Angeles', delivery_state: 'CA', delivery_zip: '90066',
  delivery_street: '5310 Beethoven St', delivery_country: 'US', is_collection: false,
  billing_name: 'Apex Technology, Inc', billing_line1: '1200 Wilshire Blvd', billing_line2: null,
  billing_city: 'Los Angeles', billing_region: 'CA', billing_postal_code: '90017',
  billing_country: 'USA', billing_email: 'ap@apex.example',
  subtotal: 100, shipping_total: 0, tax_total: 10, total: 110, taxjar_response: null,
}

const lines: InvoiceDocumentLineRow[] = [
  { line_key: 'L1', name: 'H8', description: null, quantity: 1, unit_price: 100, line_total: 100,
    is_shipping: false, ship_from_depot: 'US-BAL', tax_amount: 10, combined_tax_rate: 0.1, sort_order: 0 },
]

const render = async (over: { documentId?: string; createdAt?: Date } = {}) => {
  const doc = buildInvoiceDocument(header, lines, { remittance: REMIT, paymentTerms: 'Net 30' })
  const pdf = await buildInvoicePdf({
    document: doc,
    sellerLines: SELLER_ADDRESS_LINES,
    documentId: over.documentId ?? '79fe6d34-1e0b-4990-9c2b-627874c1a0f5',
    createdAt: over.createdAt ?? new Date('2026-09-03T00:00:00Z'),
  })
  const bytes = Buffer.from(pdf.output('arraybuffer'))
  return { bytes, sha: createHash('sha256').update(bytes).digest('hex') }
}

describe('the invoice PDF renders reproducibly', () => {
  it('two renders of the same invoice are byte-identical', async () => {
    const a = await render()
    // A real gap between the two, because the bug was a clock read to the
    // second: renders in the same second used to match by luck.
    await new Promise((r) => setTimeout(r, 1100))
    const b = await render()
    expect(b.sha).toBe(a.sha)
  })

  it('carries no wall-clock creation date and no random file id', async () => {
    const { bytes } = await render()
    const raw = bytes.toString('latin1')
    expect(raw).toContain('/CreationDate (D:20260903')
    // Pinned from the invoice id, so it is the same on every render of it.
    expect(raw).toContain('/ID [ <37396665')
  })

  it('prints its dates in US form, because the customer reading it is American', async () => {
    const { bytes } = await render()
    const raw = bytes.toString('latin1')
    // invoice_date 2026-09-03, due_date 2026-10-03. jsPDF writes text
    // uncompressed, which is what lets the /CreationDate assertion above work
    // too.
    expect(raw).toContain('September 3, 2026')
    expect(raw).toContain('October 3, 2026')
    expect(raw).not.toContain('3 September 2026')
  })

  it('a different invoice gets a different file id', async () => {
    const a = await render()
    const b = await render({ documentId: 'aaaaaaaa-1111-2222-3333-444444444444' })
    expect(b.sha).not.toBe(a.sha)
  })

  it('changing the DATA still changes the bytes, which is the point of hashing them', async () => {
    const a = await render()
    const changed = buildInvoiceDocument({ ...header, customer_po_number: 'DIFFERENT' }, lines, {
      remittance: REMIT,
      paymentTerms: 'Net 30',
    })
    const pdf = await buildInvoicePdf({
      document: changed,
      sellerLines: SELLER_ADDRESS_LINES,
      documentId: '79fe6d34-1e0b-4990-9c2b-627874c1a0f5',
      createdAt: new Date('2026-09-03T00:00:00Z'),
    })
    const sha = createHash('sha256').update(Buffer.from(pdf.output('arraybuffer'))).digest('hex')
    expect(sha).not.toBe(a.sha)
  })
})
