import { describe, it, expect } from 'vitest'
import { buildInvoiceDocument, type InvoiceDocumentHeaderRow, type InvoiceDocumentLineRow } from '@/lib/customer-invoice/invoice-document'
import type { RemittanceDetails } from '@/lib/customer-invoice/seller'

const REMIT: RemittanceDetails = {
  payee: 'Echo Barrier USA, LLC',
  bankName: null, achRouting: null, accountNumber: null, wireRouting: null, swift: null, ein: null,
}

const header = (over: Partial<InvoiceDocumentHeaderRow> = {}): InvoiceDocumentHeaderRow => ({
  invoice_number: null,
  holding_reference: 'USI2026-00010',
  invoice_date: null,
  due_date: null,
  currency: 'USD',
  company_name: 'Apex',
  customer_po_number: '11304',
  delivery_city: 'Los Angeles',
  delivery_state: 'CA',
  delivery_zip: '90066',
  delivery_street: '5310 Beethoven St',
  is_collection: false,
  billing_name: 'Apex Construction LLC',
  billing_line1: '1200 Wilshire Blvd',
  billing_line2: null,
  billing_city: 'Los Angeles',
  billing_region: 'CA',
  billing_postal_code: '90017',
  billing_country: 'US',
  billing_email: 'ap@apex.example',
  subtotal: 22295, shipping_total: 1303.64, tax_total: 2173.76, total: 25772.4,
  taxjar_response: null,
  ...over,
})

const line = (over: Partial<InvoiceDocumentLineRow>): InvoiceDocumentLineRow => ({
  line_key: 'L', name: 'Item', description: null, quantity: 1, unit_price: 0, line_total: 0,
  is_shipping: false, ship_from_depot: 'US-BAL', tax_amount: 0, combined_tax_rate: null, sort_order: 0,
  ...over,
})

/**
 * The live Apex invoice USI2026-00010, read out of korylyniwsqtsvzuzydg on
 * 2026-09-03. Its stored totals are the assertion: the document must reproduce
 * them exactly, or the customer's copy disagrees with the Hub's own record.
 */
describe('the live Apex invoice', () => {
  const doc = buildInvoiceDocument(
    header(),
    [
      line({ line_key: 'L1', name: 'LTL Freight', quantity: 1, unit_price: 1303.64, line_total: 1303.64, is_shipping: true, sort_order: 0 }),
      line({ line_key: 'L2', name: 'H8', quantity: 28, unit_price: 735, line_total: 20580, tax_amount: 2006.55, combined_tax_rate: 0.0975, sort_order: 1 }),
      line({ line_key: 'L3', name: 'H9', quantity: 7, unit_price: 245, line_total: 1715, tax_amount: 167.21, combined_tax_rate: 0.0975, sort_order: 2 }),
    ],
    { remittance: REMIT },
  )

  it('reproduces the stored totals to the cent', () => {
    expect(doc.taxableNet).toBe(22295)
    expect(doc.freight).toBe(1303.64)
    expect(doc.salesTax).toBe(2173.76)
    expect(doc.totalDue).toBe(25772.4)
  })

  it('falls back to the holding reference and says the reference is a draft', () => {
    expect(doc.reference).toBe('USI2026-00010')
    expect(doc.isDraftReference).toBe(true)
  })

  it('is a single shipment, so the table stays flat', () => {
    expect(doc.isSplit).toBe(false)
    expect(doc.shipments).toHaveLength(1)
    // The customer reads a place, not our depot code.
    expect(doc.shipments[0].label).toBe('Jessup MD')
  })

  it('puts goods before the freight they were shipped with', () => {
    // The stored sort_order has freight FIRST. On the document it belongs last:
    // it is a charge on the order, not an item in it.
    expect(doc.shipments[0].lines.map((l) => l.description)).toEqual(['H8', 'H9', 'LTL Freight'])
  })

  it('carries a null rate through as exempt rather than as zero', () => {
    const freight = doc.shipments[0].lines.find((l) => l.isShipping)
    expect(freight?.taxRate).toBeNull()
    expect(doc.freightIsTaxed).toBe(false)
  })

  it('has no TaxJar transaction id until the invoice is numbered', () => {
    expect(doc.shipments[0].taxjarTransactionId).toBeNull()
  })
})

/**
 * Dean's second mockup: one order leaving two depots to a New Jersey site,
 * where freight IS taxable. Each shipment is filed as its own TaxJar
 * transaction, and the id printed against it must be the id it was filed under.
 */
describe('an order split across two depots', () => {
  const doc = buildInvoiceDocument(
    header({ invoice_number: 'EBUS26-0007', delivery_city: 'Newark', delivery_state: 'NJ', delivery_zip: '07102' }),
    [
      line({ line_key: 'A1', name: 'H20', quantity: 24, unit_price: 950, line_total: 22800, tax_amount: 1510.5, combined_tax_rate: 0.06625, ship_from_depot: 'US-BAL', sort_order: 0 }),
      line({ line_key: 'A2', name: 'Freight', quantity: 1, unit_price: 480, line_total: 480, is_shipping: true, tax_amount: 31.8, combined_tax_rate: 0.06625, ship_from_depot: 'US-BAL', sort_order: 1 }),
      line({ line_key: 'B1', name: 'H20', quantity: 16, unit_price: 950, line_total: 15200, tax_amount: 1007, combined_tax_rate: 0.06625, ship_from_depot: 'US-SBD', sort_order: 2 }),
      line({ line_key: 'B2', name: 'Freight', quantity: 1, unit_price: 1240, line_total: 1240, is_shipping: true, tax_amount: 82.15, combined_tax_rate: 0.06625, ship_from_depot: 'US-SBD', sort_order: 3 }),
    ],
    { remittance: REMIT },
  )

  it('groups into one shipment per depot', () => {
    expect(doc.isSplit).toBe(true)
    expect(doc.shipments.map((s) => s.depot)).toEqual(['US-BAL', 'US-SBD'])
  })

  // The handover specifies "EBUS26-0001-BAL and -SBD", and Dean's mockup shows
  // the same. The country prefix is dropped from the suffix.
  it('suffixes the TaxJar transaction id with the depot, as the filing does', () => {
    expect(doc.shipments.map((s) => s.taxjarTransactionId)).toEqual(['EBUS26-0007-BAL', 'EBUS26-0007-SBD'])
  })

  it('subtotals each shipment', () => {
    expect(doc.shipments[0].net).toBe(23280)
    expect(doc.shipments[0].tax).toBe(1542.3)
    expect(doc.shipments[1].net).toBe(16440)
    expect(doc.shipments[1].tax).toBe(1089.15)
  })

  it('totals the invoice across both', () => {
    expect(doc.taxableNet).toBe(38000)
    expect(doc.freight).toBe(1720)
    expect(doc.salesTax).toBe(2631.45)
    expect(doc.totalDue).toBe(42351.45)
  })

  it('reports the freight as taxed, which is New Jersey and not California', () => {
    expect(doc.freightIsTaxed).toBe(true)
  })
})

describe('edge cases', () => {
  it('a numbered single shipment files under the bare invoice number', () => {
    const doc = buildInvoiceDocument(
      header({ invoice_number: 'EBUS26-0001' }),
      [line({ line_key: 'L1', name: 'H8', quantity: 1, unit_price: 100, line_total: 100 })],
      { remittance: REMIT },
    )
    expect(doc.shipments[0].taxjarTransactionId).toBe('EBUS26-0001')
    expect(doc.isDraftReference).toBe(false)
  })

  it('folds a freight-only depot into the depot that carries the goods', () => {
    // buildFilingOrders attributes it this way, so the document has to as well:
    // filing the freight in a jurisdiction the calculation never used is the
    // failure this mirrors.
    const doc = buildInvoiceDocument(
      header(),
      [
        line({ line_key: 'G', name: 'H8', quantity: 1, unit_price: 100, line_total: 100, ship_from_depot: 'US-BAL' }),
        line({ line_key: 'F', name: 'Freight', quantity: 1, unit_price: 50, line_total: 50, is_shipping: true, ship_from_depot: 'US-SBD' }),
      ],
      { remittance: REMIT },
    )
    expect(doc.shipments).toHaveLength(1)
    expect(doc.shipments[0].depot).toBe('US-BAL')
    expect(doc.shipments[0].lines.map((l) => l.description)).toEqual(['H8', 'Freight'])
  })

  it('says so when the customer is collecting rather than being shipped to', () => {
    const doc = buildInvoiceDocument(
      header({ is_collection: true }),
      [line({ line_key: 'L1', name: 'H8', quantity: 1, unit_price: 100, line_total: 100 })],
      { remittance: REMIT },
    )
    expect(doc.shipTo).toEqual(['Collected by the customer'])
  })

  it('renders nothing rather than throwing when there are no product lines', () => {
    const doc = buildInvoiceDocument(header(), [], { remittance: REMIT })
    expect(doc.shipments).toEqual([])
    expect(doc.totalDue).toBe(0)
  })
})

describe('addresses on the document', () => {
  const doc = buildInvoiceDocument(
    header(),
    [line({ line_key: 'L1', name: 'H8', quantity: 1, unit_price: 100, line_total: 100 })],
    { remittance: REMIT },
  )

  it('prints the delivery address in full, street included', () => {
    // Previously only "Los Angeles, CA 90066" printed. A delivery address with
    // no street is not a delivery address, and it is what the tax was
    // calculated against.
    expect(doc.shipTo).toEqual(['5310 Beethoven St', 'Los Angeles, CA 90066'])
  })

  it('prints the Xero contact as the bill-to', () => {
    expect(doc.billTo).toEqual([
      'Apex Construction LLC',
      '1200 Wilshire Blvd',
      'Los Angeles, CA 90017',
      'US',
      'ap@apex.example',
    ])
  })

  it('falls back to the company name and skips what Xero does not hold', () => {
    const bare = buildInvoiceDocument(
      header({ billing_name: null, billing_line1: null, billing_line2: null, billing_city: null,
               billing_region: null, billing_postal_code: null, billing_country: null, billing_email: null }),
      [line({ line_key: 'L1', name: 'H8', quantity: 1, unit_price: 100, line_total: 100 })],
      { remittance: REMIT },
    )
    expect(bare.billTo).toEqual(['Apex'])
  })

  it('names the depot by place, never by code', () => {
    const split = buildInvoiceDocument(
      header({ invoice_number: 'EBUS26-0007' }),
      [
        line({ line_key: 'A', name: 'H20', quantity: 1, unit_price: 1, line_total: 1, ship_from_depot: 'US-BAL' }),
        line({ line_key: 'B', name: 'H20', quantity: 1, unit_price: 1, line_total: 1, ship_from_depot: 'US-SBD' }),
      ],
      { remittance: REMIT },
    )
    expect(split.shipments.map((s) => s.label)).toEqual(['Jessup MD', 'Rancho Cucamonga CA'])
  })
})
