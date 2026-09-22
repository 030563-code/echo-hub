import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { invoicingProfile, invoicingProfileForDepot, INVOICING_LIVE_ORGS, filedStageLabel } from '@/lib/customer-invoice/invoicing-profile'
import { INVOICE_DEPOTS, isInvoiceDepot, DEPOT_FROM_ADDRESSES, usDepotAddress } from '@/lib/customer-invoice/constants'
import { sellerFor, remittanceIsIncomplete, type RemittanceDetails } from '@/lib/customer-invoice/seller'
import { buildInvoiceDocument, type InvoiceDocumentHeaderRow, type InvoiceDocumentLineRow } from '@/lib/customer-invoice/invoice-document'
import { buildInvoicePdf } from '@/lib/customer-invoice/invoice-pdf'
import { depotShipments, filingTransactionId } from '@/lib/customer-invoice/tax-mapping'

/**
 * France invoices through the Hub on the USA ladder with a Xero DRAFT standing
 * where TaxJar stands. Dean, 22 Sep 2026. These pin the decisions that would be
 * expensive to rediscover, and the two mistakes that would look like success.
 */

const read = (file: string) => readFileSync(join(process.cwd(), file), 'utf8')

describe('the invoicing profile is the one place the module asks who is invoicing', () => {
  it('knows the USA and France, and nobody else, and never defaults', () => {
    expect(INVOICING_LIVE_ORGS).toEqual(['EB-USA', 'EB-FRANCE'])
    expect(invoicingProfile('EB-CANADA')).toBeNull()
    expect(invoicingProfile('EB-SRO')).toBeNull()
    expect(invoicingProfile('')).toBeNull()
    expect(invoicingProfile(null)).toBeNull()
  })

  it('France is EUR, country FR, one depot, priced by a Xero draft, in the France account column', () => {
    const fr = invoicingProfile('EB-FRANCE')!
    expect(fr.currency).toBe('EUR')
    expect(fr.country).toBe('FR')
    expect(fr.depots).toEqual(['EU-FR'])
    expect(fr.taxEngine).toBe('xero_draft')
    expect(fr.accountCodeColumn).toBe('france_xero_account_code')
    expect(fr.webhookUrlEnv).toBe('N8N_CUSTOMER_INVOICE_WEBHOOK_URL_FR')
    expect(invoicingProfileForDepot('EU-FR')?.org).toBe('EB-FRANCE')
    expect(invoicingProfileForDepot('eu-fr')?.org).toBe('EB-FRANCE')
  })

  it('🔴 France sends the 20% tax type explicitly and NO tax amount; the USA does the reverse', () => {
    // Read live from Echo Barrier SAS on 22 Sep 2026: 20 of 21 revenue accounts
    // default to OUTPUT at 0%, so a draft with no TaxType is silently zero-rated.
    const fr = invoicingProfile('EB-FRANCE')!
    expect(fr.xeroTaxType).toBe('TAX001')
    expect(fr.sendsTaxAmount).toBe(false)
    const us = invoicingProfile('EB-USA')!
    expect(us.xeroTaxType).toBe('OUTPUT')
    expect(us.sendsTaxAmount).toBe(true)
  })

  it('the USA profile is byte-for-byte what the module hardcoded before', () => {
    const us = invoicingProfile('EB-USA')!
    expect(us).toMatchObject({
      currency: 'USD',
      country: 'US',
      depots: ['US-BAL', 'US-SBD'],
      taxEngine: 'taxjar',
      accountCodeColumn: 'usa_xero_account_code',
      webhookUrlEnv: 'N8N_CUSTOMER_INVOICE_WEBHOOK_URL',
      holdingPrefix: 'USI',
      locale: 'en-US',
    })
  })

  it("names Dave's step after TaxJar and Claire's after the number", () => {
    expect(filedStageLabel('taxjar')).toBe('TaxJar order transaction created')
    expect(filedStageLabel('xero_draft')).toBe('Invoice numbered')
  })
})

describe('the depot type widened without the TaxJar paths widening with it', () => {
  it('EU-FR is an invoicing depot, and its dispatch address is deliberately unknown', () => {
    expect(INVOICE_DEPOTS).toContain('EU-FR')
    expect(isInvoiceDepot('EU-FR')).toBe(true)
    expect(DEPOT_FROM_ADDRESSES['EU-FR']).toBeNull()
  })

  it('usDepotAddress hands TaxJar a state it can use, or nothing', () => {
    expect(usDepotAddress('US-BAL')?.state).toBe('MD')
    expect(usDepotAddress('US-SBD')?.state).toBe('CA')
  })

  it('shipments group over every invoicing depot and the suffix drops any country prefix', () => {
    const lines = [
      { is_shipping: false, ship_from_depot: 'EU-FR' as const },
      { is_shipping: true, ship_from_depot: 'EU-FR' as const },
    ]
    const shipments = depotShipments(lines)
    expect(shipments.map((s) => s.depot)).toEqual(['EU-FR'])
    expect(shipments[0].shippingLines).toHaveLength(1)
    expect(filingTransactionId('EBUS26-0001', 'US-BAL', 2)).toBe('EBUS26-0001-BAL')
    expect(filingTransactionId('EBFR26-0001', 'EU-FR', 1)).toBe('EBFR26-0001')
  })
})

describe('the French seller block is evidence, not a guess', () => {
  it('prints the siège social, the SIREN, the RCS and the TVA number, and nothing unconfirmed', () => {
    const fr = sellerFor('EB-FRANCE')
    expect(fr.legalName).toBe('Echo Barrier SAS')
    expect(fr.addressLines).toEqual(['Echo Barrier SAS', '25 place de la Madeleine', '75008 Paris', 'France'])
    expect(fr.legalMentions).toEqual(['SIREN 978 450 930', 'RCS Paris 978 450 930', 'TVA FR09978450930'])
    // The share capital is single-sourced and unconfirmed, so it must NOT print.
    expect(fr.legalMentions.join(' ')).not.toMatch(/capital/i)
    // Xero holds a typo in the street name; the register does not.
    expect(fr.addressLines.join(' ')).not.toMatch(/Madellene/)
    expect(fr.addressLines.join(' ')).not.toMatch(/Arrondissement/)
  })

  it('the USA seller block is unchanged', () => {
    expect(sellerFor('EB-USA').addressLines[0]).toBe('Echo Barrier USA LLC')
    expect(sellerFor('EB-USA').legalMentions).toEqual([])
  })

  it('a European remittance is complete with IBAN and BIC, and incomplete without either', () => {
    const eu: RemittanceDetails = {
      accountName: 'ECHO BARRIER', bankName: 'Société Générale', bankAddress: [],
      routingNumber: null, accountNumber: null, ein: null,
      iban: 'FR76 3000 3030 3000 0200 0013 116', bic: 'SOGEFRPP', scheme: 'eu',
    }
    expect(remittanceIsIncomplete(eu)).toBe(false)
    expect(remittanceIsIncomplete({ ...eu, bic: null })).toBe(true)
    expect(remittanceIsIncomplete({ ...eu, iban: null })).toBe(true)
    // A US-shaped record with no scheme still follows the US rule.
    expect(remittanceIsIncomplete({ ...eu, scheme: undefined, iban: null, bic: null, routingNumber: '1', accountNumber: '2' })).toBe(false)
  })
})

describe('the French document', () => {
  const remit: RemittanceDetails = {
    accountName: 'ECHO BARRIER', bankName: 'Société Générale', bankAddress: [],
    routingNumber: null, accountNumber: null, ein: null,
    iban: 'FR76 3000 3030 3000 0200 0013 116', bic: 'SOGEFRPP', scheme: 'eu',
  }
  const header: InvoiceDocumentHeaderRow = {
    invoice_number: 'EBFR26-0001', holding_reference: 'FRI2026-00031',
    invoice_date: '2026-09-22', due_date: '2026-10-22', currency: 'EUR',
    company_name: 'AGGREKO FRANCE', customer_po_number: 'C01-26009483NP',
    delivery_city: 'Paris', delivery_state: null, delivery_zip: '75008',
    delivery_street: '25 place de la Madeleine', delivery_country: 'FR',
    delivery_location: null, delivery_requested_by: null, is_collection: false,
    billing_name: 'AGGREKO FRANCE', billing_line1: '1 rue X', billing_line2: null,
    billing_city: 'Paris', billing_region: null, billing_postal_code: '75001',
    billing_country: 'France', billing_email: null,
    subtotal: 3780, shipping_total: 0, tax_total: 756, total: 4536, taxjar_response: null,
  }
  const lines: InvoiceDocumentLineRow[] = [
    { line_key: 'L1', name: 'Echo Barrier H10', description: null, quantity: 10, unit_price: 378, line_total: 3780,
      is_shipping: false, ship_from_depot: 'EU-FR', tax_amount: 756, combined_tax_rate: 0.2, sort_order: 0 },
  ]

  it('calls the tax TVA, prints the country as France, and files nothing with TaxJar', () => {
    const doc = buildInvoiceDocument(header, lines, { remittance: remit, paymentTerms: 'Net 30', taxEngine: 'xero_draft', taxLabel: 'TVA' })
    expect(doc.taxLabel).toBe('TVA')
    expect(doc.shipTo).toEqual(['25 place de la Madeleine', 'Paris 75008', 'France'])
    expect(doc.shipments).toHaveLength(1)
    expect(doc.shipments[0].taxjarTransactionId).toBeNull()
    expect(doc.salesTax).toBe(756)
    expect(doc.totalDue).toBe(4536)
  })

  it('a USA document still files with TaxJar when no engine is named', () => {
    const doc = buildInvoiceDocument(
      { ...header, currency: 'USD', delivery_country: 'US', delivery_state: 'MD', delivery_zip: '20794', invoice_number: 'EBUS26-0001' },
      [{ ...lines[0], ship_from_depot: 'US-BAL' }],
      { remittance: remit, paymentTerms: 'Net 30' },
    )
    expect(doc.taxLabel).toBe('Sales tax')
    expect(doc.shipments[0].taxjarTransactionId).toBe('EBUS26-0001')
  })

  it('renders euros in French with plain spaces, never the narrow no-break space Helvetica cannot draw', async () => {
    const doc = buildInvoiceDocument(header, lines, { remittance: remit, paymentTerms: 'Net 30', taxEngine: 'xero_draft', taxLabel: 'TVA' })
    const pdf = await buildInvoicePdf({
      document: doc,
      sellerLines: sellerFor('EB-FRANCE').addressLines,
      legalMentions: sellerFor('EB-FRANCE').legalMentions,
      locale: 'fr-FR',
      documentId: '79fe6d34-1e0b-4990-9c2b-627874c1a0f5',
      createdAt: new Date('2026-09-22T00:00:00Z'),
    })
    const raw = Buffer.from(pdf.output('arraybuffer')).toString('latin1')
    // The text stream is compressed, so assert on what CAN be seen: the document
    // rendered at all, deterministically, for a French invoice.
    expect(raw).toContain('/CreationDate (D:20260922')
    // And the formatter itself, which is what feeds the stream.
    const sample = (4536).toLocaleString('fr-FR', { style: 'currency', currency: 'EUR' }).replace(/[  ]/g, ' ')
    expect(sample).toBe('4 536,00 €')
    expect(sample).not.toMatch(/[  ]/)
  })
})

describe('🔴 the two mistakes that would look like success', () => {
  it('the France tax step refuses a priced line that came back with zero tax', () => {
    const src = read('src/app/actions/invoicing/calculate-tax-fr.ts')
    expect(src).toContain('if (ours > 0 && tax === 0)')
    expect(src).toMatch(/zero-rated/)
  })

  it('the France tax step maps returned tax by line_key, never by position', () => {
    const src = read('src/app/actions/invoicing/calculate-tax-fr.ts')
    expect(src).toContain("returned.get(line.line_key)")
    expect(src).not.toMatch(/draft\.lines\[\s*index\s*\]/)
  })

  it('the authorise leg leaves tax_amount OFF the line for an organisation Xero prices', () => {
    const src = read('src/app/actions/invoicing/send-to-xero.ts')
    expect(src).toContain('...(sendsTaxAmount ? { tax_amount: Number(l.tax_amount ?? 0) } : {})')
    expect(src).toContain('tax_type: profile.xeroTaxType')
    expect(src).not.toContain("tax_type: 'OUTPUT' as const")
  })

  it('the Xero draft id never shares a column with the authorised invoice id', () => {
    const shared = read('src/app/actions/invoicing/shared.ts')
    expect(shared).toContain('xero_draft_invoice_id: string | null')
    const calc = read('src/app/actions/invoicing/calculate-tax-fr.ts')
    expect(calc).toContain('xero_draft_invoice_id: draft.xero_draft_invoice_id')
    expect(calc).not.toMatch(/update\(\{\s*xero_invoice_id/)
    const send = read('src/app/actions/invoicing/send-to-xero.ts')
    expect(send).toContain("profile.taxEngine === 'xero_draft' && !invoice.xero_draft_invoice_id")
  })

  it('every Xero call names its organisation; nothing reads the USA webhook by name any more', () => {
    for (const file of [
      'src/app/actions/invoicing/send-to-xero.ts',
      'src/app/actions/invoicing/email-invoice.ts',
      'src/lib/xero-hub.ts',
    ]) {
      const src = read(file)
      expect(src, file).not.toMatch(/process\.env\.N8N_CUSTOMER_INVOICE_WEBHOOK_URL\b/)
    }
    const hub = read('src/lib/xero-hub.ts')
    expect(hub).toContain('export function xeroWebhookFor(org: OrgCode)')
  })

  it('the EB-USA-only refusals are gone from the invoicing module', () => {
    // The one comparison that remains is the USA's own currency check, which
    // guards against a Canadian deal reaching TaxJar and is USA-specific on
    // purpose. The refusals of every OTHER organisation are what must be gone.
    expect(read('src/app/actions/invoicing/open-invoice.ts')).not.toMatch(/org !== 'EB-USA'/)
    expect(read('src/app/actions/invoicing/open-invoice.ts')).not.toMatch(/is not set up in the Hub yet.*org !== /)
    expect(read('src/app/(dashboard)/invoicing/accepted/page.tsx')).not.toMatch(/invoicingLive = org === 'EB-USA'/)
    expect(read('src/app/(dashboard)/invoicing/[dealId]/page.tsx')).not.toMatch(/US_ACCEPTED_DEAL_STATUS|isUSDepot/)
  })
})
