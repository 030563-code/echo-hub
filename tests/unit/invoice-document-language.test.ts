import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildInvoiceDocument, type InvoiceDocumentHeaderRow, type InvoiceDocumentLineRow } from '@/lib/customer-invoice/invoice-document'
import { buildInvoicePdf } from '@/lib/customer-invoice/invoice-pdf'
import {
  SELLER_ADDRESS_LINES,
  SELLER_EMAIL,
  SELLER_PHONE,
  sellerFor,
  type RemittanceDetails,
} from '@/lib/customer-invoice/seller'
import { INVOICE_LABELS, fillLabel, type InvoiceLabels } from '@/lib/customer-invoice/invoice-labels'
import {
  DOCUMENT_LANGUAGES,
  dateLocaleFor,
  documentLanguage,
  documentLanguagesFor,
  formatDocumentDate,
  invoiceLanguage,
  languageFromHubSpot,
  pickAcceptedQuote,
  type DealQuote,
  type DocumentLanguage,
} from '@/lib/customer-invoice/document-language'
import { readDealQuoteLanguage } from '@/lib/customer-invoice/document-language.server'
import { invoicingProfile } from '@/lib/customer-invoice/invoicing-profile'

/**
 * The customer invoice in English, French and Spanish.
 *
 * Claire invoices French customers mostly and Spanish ones too, and the PDF
 * printed English labels whoever it was for. These pin four things: every label
 * exists in all three languages and fits the space the page gives it, a French
 * and a Spanish invoice really print their own words and dates, an English
 * invoice is byte for byte what it was before, and the rule that picks a new
 * invoice's language from the deal's HubSpot quote.
 *
 * Every company, address, number and bank detail here is invented.
 */

const read = (file: string) => readFileSync(join(process.cwd(), file), 'utf8')

/**
 * WinAnsi's bytes 0x80 to 0x9F, where it differs from latin1: the euro sign is
 * 0x80. Spelled out because Node's TextDecoder('windows-1252') reads that range
 * as latin1 control characters (checked on Node 25), which would turn every
 * euro amount into an unreadable string.
 */
const WIN_ANSI_HIGH: Record<number, number> = {
  0x80: 0x20ac, 0x82: 0x201a, 0x83: 0x0192, 0x84: 0x201e, 0x85: 0x2026, 0x86: 0x2020, 0x87: 0x2021,
  0x88: 0x02c6, 0x89: 0x2030, 0x8a: 0x0160, 0x8b: 0x2039, 0x8c: 0x0152, 0x8e: 0x017d, 0x91: 0x2018,
  0x92: 0x2019, 0x93: 0x201c, 0x94: 0x201d, 0x95: 0x2022, 0x96: 0x2013, 0x97: 0x2014, 0x98: 0x02dc,
  0x99: 0x2122, 0x9a: 0x0161, 0x9b: 0x203a, 0x9c: 0x0153, 0x9e: 0x017e, 0x9f: 0x0178,
}

/**
 * Every string the PDF draws, in order, read from the finished bytes. The
 * customer invoice draws in Helvetica, whose text jsPDF writes uncompressed in
 * WinAnsi, one `(...) Tj` per drawn line. Reading the bytes rather than
 * recording doc.text calls (pdf-text.ts, for the renderers with a subset
 * Unicode font) also proves each accent and the euro sign survived the
 * encoding, which is where a French invoice would go wrong.
 */
function pdfTexts(bytes: Buffer): string[] {
  const raw = Array.from(bytes, (b) => String.fromCharCode(WIN_ANSI_HIGH[b] ?? b)).join('')
  const out: string[] = []
  const re = /\(((?:\\.|[^\\)])*)\)\s*Tj/g
  let m: RegExpExecArray | null
  while ((m = re.exec(raw))) out.push(m[1].replace(/\\([()\\])/g, '$1'))
  return out
}

const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')

// ---------------------------------------------------------------------------
// An invented French customer, invoiced by Echo Barrier SAS
// ---------------------------------------------------------------------------

const FR_REMIT: RemittanceDetails = {
  accountName: 'ECHO BARRIER', bankName: 'Banque Exemple', bankAddress: [],
  routingNumber: null, accountNumber: null, ein: null,
  iban: 'FR00 0000 0000 0000 0000 0000 000', bic: 'EXMPFRPP', scheme: 'eu',
}

const FR_HEADER: InvoiceDocumentHeaderRow = {
  invoice_number: 'EBFR26-0999', holding_reference: 'FRI2026-00999',
  invoice_date: '2026-09-24', due_date: '2026-10-01', currency: 'EUR',
  company_name: 'Chantiers Exemple SARL', customer_po_number: 'BC-2026-0042',
  delivery_city: 'Lyon', delivery_state: null, delivery_zip: '69001',
  delivery_street: '12 rue des Exemples', delivery_country: 'FR',
  delivery_location: 'Site Nord', delivery_requested_by: 'Camille Exemple', is_collection: false,
  billing_name: 'Chantiers Exemple SARL', billing_line1: '3 avenue Fictive', billing_line2: null,
  billing_city: 'Lyon', billing_region: null, billing_postal_code: '69002',
  billing_country: 'France', billing_email: null,
  subtotal: 3780, shipping_total: 150, tax_total: 786, total: 4716, taxjar_response: null,
}

const FR_LINES: InvoiceDocumentLineRow[] = [
  { line_key: 'L1', name: 'Echo Barrier H10', description: null, quantity: 10, unit_price: 378, line_total: 3780,
    is_shipping: false, ship_from_depot: 'EU-FR', tax_amount: 756, combined_tax_rate: 0.2, sort_order: 0 },
  { line_key: 'L2', name: 'Transport', description: null, quantity: 1, unit_price: 150, line_total: 150,
    is_shipping: true, ship_from_depot: 'EU-FR', tax_amount: 30, combined_tax_rate: 0.2, sort_order: 1 },
  // Priced at zero, so Xero returns no rate for it.
  { line_key: 'L3', name: 'Accessoire offert', description: null, quantity: 2, unit_price: 0, line_total: 0,
    is_shipping: false, ship_from_depot: 'EU-FR', tax_amount: 0, combined_tax_rate: null, sort_order: 2 },
]

async function renderFrance(language: DocumentLanguage, header: InvoiceDocumentHeaderRow = FR_HEADER) {
  const seller = sellerFor('EB-FRANCE')
  const document = buildInvoiceDocument(header, FR_LINES, {
    remittance: FR_REMIT, paymentTerms: 'Net 30', taxEngine: 'xero_draft', taxLabel: 'TVA', language,
  })
  const pdf = await buildInvoicePdf({
    document,
    sellerLines: seller.addressLines,
    sellerPhone: seller.phone,
    sellerEmail: 'factures@example.com',
    legalMentions: seller.legalMentions,
    locale: 'fr-FR',
    documentId: '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d',
    createdAt: new Date('2026-09-24T00:00:00Z'),
  })
  const bytes = Buffer.from(pdf.output('arraybuffer'))
  return { document, bytes, texts: pdfTexts(bytes) }
}

const DRAFT = { ...FR_HEADER, invoice_number: null, invoice_date: null, due_date: null }
const COLLECTED = { ...FR_HEADER, is_collection: true }

// ---------------------------------------------------------------------------

describe('every label exists in all three languages', () => {
  const keys = (language: DocumentLanguage) => Object.keys(INVOICE_LABELS[language]).sort()

  it('carries the same keys in each, with nothing blank', () => {
    expect(DOCUMENT_LANGUAGES).toEqual(['en', 'fr', 'es'])
    expect(keys('fr')).toEqual(keys('en'))
    expect(keys('es')).toEqual(keys('en'))
    // A floor, so a table that quietly lost most of its keys cannot pass.
    expect(keys('en').length).toBeGreaterThanOrEqual(40)
    for (const language of DOCUMENT_LANGUAGES) {
      for (const [key, value] of Object.entries(INVOICE_LABELS[language])) {
        expect(typeof value, `${language}.${key}`).toBe('string')
        expect(value.trim(), `${language}.${key}`).not.toBe('')
      }
    }
  })

  it('has no English left in the French or Spanish table', () => {
    // An identical pair is the signature of a key added to English and copied
    // across. The only exceptions are words the languages genuinely share.
    const shared: Record<'fr' | 'es', (keyof InvoiceLabels)[]> = {
      fr: ['iban', 'bic'],
      es: ['iban', 'bic', 'shipmentSubtotal'],
    }
    for (const language of ['fr', 'es'] as const) {
      for (const key of Object.keys(INVOICE_LABELS.en) as (keyof InvoiceLabels)[]) {
        if (shared[language].includes(key)) continue
        expect(INVOICE_LABELS[language][key], `${language}.${key} is the English`).not.toBe(INVOICE_LABELS.en[key])
      }
    }
  })

  it('keeps every {placeholder} in every language, so no value is lost', () => {
    const holes = (s: string) => (s.match(/\{(\w+)\}/g) ?? []).sort()
    for (const key of Object.keys(INVOICE_LABELS.en) as (keyof InvoiceLabels)[]) {
      expect(holes(INVOICE_LABELS.fr[key]), `fr.${key}`).toEqual(holes(INVOICE_LABELS.en[key]))
      expect(holes(INVOICE_LABELS.es[key]), `es.${key}`).toEqual(holes(INVOICE_LABELS.en[key]))
    }
  })

  it('writes proper invoice French and Spanish, not word-for-word English', () => {
    expect(INVOICE_LABELS.fr.title).toBe('Facture')
    expect(INVOICE_LABELS.es.title).toBe('Factura')
    expect(INVOICE_LABELS.fr.colDescription).toBe('DÉSIGNATION')
    expect(INVOICE_LABELS.fr.colUnitPrice).toBe('PU HT')
    expect(INVOICE_LABELS.fr.colLineTotal).toBe('TOTAL TTC')
    expect(INVOICE_LABELS.fr.totalDue).toBe('Total à payer')
    expect(INVOICE_LABELS.es.totalDue).toBe('Total a pagar')
    expect(INVOICE_LABELS.es.colRate).toBe('TIPO')
    // What a Spanish payer types into the transfer.
    expect(INVOICE_LABELS.es.paymentReference).toBe('Concepto')
  })

  it('never claims a legal tax exemption in French or Spanish on a line with no rate', () => {
    // exonéré and exento are legal claims that must cite an article; the only
    // line that reaches that cell on a Xero-priced invoice is one priced at zero.
    expect(INVOICE_LABELS.fr.noRate).not.toMatch(/exon/i)
    expect(INVOICE_LABELS.es.noRate).not.toMatch(/exent/i)
  })

  it('fills placeholders with the value as typed, even one that looks like a pattern', () => {
    expect(fillLabel(INVOICE_LABELS.fr.requestedBy, { name: 'A $& B' })).toBe('Demandé par : A $& B')
    expect(fillLabel(INVOICE_LABELS.es.shipments, { count: 2, places: 'Uno y Dos' })).toBe('2 envíos, Uno y Dos')
  })

  it('contains no long dash in any language', () => {
    for (const language of DOCUMENT_LANGUAGES) {
      for (const value of Object.values(INVOICE_LABELS[language])) expect(value).not.toMatch(/\u2014/)
    }
  })
})

describe('every label fits the space the page gives it', async () => {
  // Measured in the PDF's own font. The limits come from the layout in
  // invoice-pdf.ts: a 182 mm text width, three meta columns of 60 mm less
  // padding, a 30 mm gap before each payment value, and France's letterhead,
  // whose last lines start about 166 mm across the page, level with the draft
  // warning. The first French draft warning ran into that TVA line.
  const { default: JsPDF } = await import('jspdf')
  const doc = new JsPDF()
  const width = (text: string, size: number, style: 'normal' | 'bold') => {
    doc.setFont('helvetica', style)
    doc.setFontSize(size)
    return doc.getTextWidth(text)
  }
  const limits: [keyof InvoiceLabels, number, 'normal' | 'bold', number][] = [
    ['title', 22, 'bold', 100],
    ['draftTitle', 22, 'bold', 100],
    ['draftWarning', 10, 'bold', 140],
    ['invoiceNumber', 7, 'normal', 52],
    ['draftReference', 7, 'normal', 52],
    ['issued', 7, 'normal', 52],
    ['due', 7, 'normal', 52],
    ['customerPo', 7, 'normal', 52],
    ['despatchedFrom', 7, 'normal', 52],
    ['billTo', 7, 'normal', 80],
    ['shipTo', 7, 'normal', 80],
    ['collection', 7, 'normal', 80],
    ['colDescription', 8, 'bold', 55],
    ['colQuantity', 8, 'bold', 20],
    ['colUnitPrice', 8, 'bold', 20],
    ['colNet', 8, 'bold', 20],
    ['colRate', 8, 'bold', 20],
    ['colTax', 8, 'bold', 20],
    ['colLineTotal', 8, 'bold', 20],
    ['taxableNet', 9, 'normal', 60],
    ['freightTaxable', 9, 'normal', 60],
    ['freightNotTaxable', 9, 'normal', 60],
    ['totalDue', 11, 'bold', 60],
    ['howToPay', 11, 'bold', 80],
    ['accountName', 9, 'normal', 28],
    ['bank', 9, 'normal', 28],
    ['bankAddress', 9, 'normal', 28],
    ['routingNumber', 9, 'normal', 28],
    ['accountNumber', 9, 'normal', 28],
    ['iban', 9, 'normal', 28],
    ['bic', 9, 'normal', 28],
    ['paymentReference', 9, 'normal', 28],
  ]
  for (const language of DOCUMENT_LANGUAGES) {
    it(`in ${language}`, () => {
      for (const [key, size, style, max] of limits) {
        expect(width(INVOICE_LABELS[language][key], size, style), `${language}.${key}`).toBeLessThanOrEqual(max)
      }
    })
  }
})

describe('a French invoice prints in French', () => {
  it('labels, dates and the first of the month as an ordinal', async () => {
    const { texts } = await renderFrance('fr')
    for (const expected of [
      'Facture', 'FACTURE N°', "DATE D'ÉMISSION", 'ÉCHÉANCE', 'N° DE COMMANDE CLIENT', 'EXPÉDIÉ DEPUIS',
      'ADRESSE DE FACTURATION', 'ADRESSE DE LIVRAISON', 'Demandé par : Camille Exemple',
      'DÉSIGNATION', 'QTÉ', 'PU HT', 'MONTANT HT', 'TAUX', 'TAXE', 'TOTAL TTC', 'non taxé',
      'Net HT', 'Frais de transport (imposables)', 'Total à payer',
      'Modalités de paiement', 'Titulaire du compte', 'Banque', 'IBAN', 'BIC', 'Référence',
      '24 septembre 2026',
    ]) {
      expect(texts, expected).toContain(expected)
    }
    expect(texts).toContain('1er octobre 2026  ·  Net 30')
  })

  it('a draft says what it is, in French', async () => {
    const { texts } = await renderFrance('fr', DRAFT)
    expect(texts).toContain('Projet de facture')
    expect(texts).toContain(INVOICE_LABELS.fr.draftWarning)
    expect(texts).toContain('RÉFÉRENCE PROVISOIRE')
    expect(texts).toContain('FRI2026-00999')
  })

  it('a collected order says so, in French', async () => {
    const { document, texts } = await renderFrance('fr', COLLECTED)
    expect(document.shipTo).toEqual(['Enlèvement par le client', 'Demandé par : Camille Exemple'])
    expect(texts).toContain('ENLÈVEMENT')
  })
})

describe('a Spanish invoice prints in Spanish', () => {
  it('labels and dates', async () => {
    const { texts } = await renderFrance('es')
    for (const expected of [
      'Factura', 'FACTURA N.º', 'FECHA DE EMISIÓN', 'VENCIMIENTO', 'N.º DE PEDIDO DEL CLIENTE', 'ENVIADO DESDE',
      'DIRECCIÓN DE FACTURACIÓN', 'DIRECCIÓN DE ENTREGA', 'Solicitado por: Camille Exemple',
      'DESCRIPCIÓN', 'CANT.', 'PRECIO', 'IMPORTE', 'TIPO', 'IMPUESTO', 'TOTAL', 'sin impuesto',
      'Importe neto', 'Transporte (sujeto a impuesto)', 'Total a pagar',
      'Forma de pago', 'Titular de la cuenta', 'Banco', 'IBAN', 'BIC', 'Concepto',
      '24 de septiembre de 2026',
    ]) {
      expect(texts, expected).toContain(expected)
    }
    expect(texts).toContain('1 de octubre de 2026  ·  Net 30')
  })

  it('a draft and a collected order, in Spanish', async () => {
    const draft = await renderFrance('es', DRAFT)
    expect(draft.texts).toContain('Borrador de factura')
    expect(draft.texts).toContain(INVOICE_LABELS.es.draftWarning)
    expect(draft.texts).toContain('REFERENCIA PROVISIONAL')
    const collected = await renderFrance('es', COLLECTED)
    expect(collected.document.shipTo).toEqual(['Recogida por el cliente', 'Solicitado por: Camille Exemple'])
    expect(collected.texts).toContain('RECOGIDA')
  })
})

describe('only the labels change', () => {
  it('leaves no English label on a French or Spanish invoice', async () => {
    const english = Object.entries(INVOICE_LABELS.en)
      .filter(([key]) => key !== 'iban' && key !== 'bic')
      .map(([, value]) => value)
    const exact = english.filter((v) => !v.includes('{'))
    const prefixes = english.filter((v) => v.includes('{')).map((v) => v.slice(0, v.indexOf('{')).trim()).filter((p) => p !== '')
    for (const language of ['fr', 'es'] as const) {
      for (const header of [FR_HEADER, DRAFT, COLLECTED]) {
        const { texts } = await renderFrance(language, header)
        for (const label of exact) expect(texts, `${language}: ${label}`).not.toContain(label)
        for (const prefix of prefixes) {
          // Spanish shares "Subtotal," with English, and this order has one depot.
          if (language === 'es' && prefix === 'Subtotal,') continue
          expect(texts.some((t) => t.startsWith(prefix)), `${language}: ${prefix}`).toBe(false)
        }
      }
    }
  })

  it('prints every amount, the tax name, the legal mentions and the stored terms the same in every language', async () => {
    const renders = await Promise.all(DOCUMENT_LANGUAGES.map((language) => renderFrance(language)))
    const money = (texts: string[]) => texts.filter((t) => t.includes('€'))
    const [en, fr, es] = renders.map((r) => r.texts)
    expect(money(fr)).toEqual(money(en))
    expect(money(es)).toEqual(money(en))
    expect(money(en)).toContain('4 716,00 €')
    for (const texts of [en, fr, es]) {
      expect(texts).toContain('TVA')
      expect(texts).toContain('20.000%')
      for (const mention of sellerFor('EB-FRANCE').legalMentions) expect(texts).toContain(mention)
      for (const line of sellerFor('EB-FRANCE').addressLines) expect(texts).toContain(line)
      expect(texts).toContain('Chantiers Exemple SARL')
      // The terms are a value snapshotted from Xero, not a label.
      expect(texts.some((t) => t.endsWith('Net 30'))).toBe(true)
    }
  })

  it('writes English from France in British order, and euros still the French way', async () => {
    const { texts } = await renderFrance('en')
    expect(texts).toContain('Invoice')
    expect(texts).toContain('24 September 2026')
    expect(texts).toContain('1 October 2026  ·  Net 30')
    expect(texts).toContain('4 716,00 €')
  })

  it('renders one invoice in one language reproducibly, and the language is part of what the hash protects', async () => {
    const a = await renderFrance('fr')
    const b = await renderFrance('fr')
    const c = await renderFrance('es')
    expect(sha(b.bytes)).toBe(sha(a.bytes))
    expect(sha(c.bytes)).not.toBe(sha(a.bytes))
  })
})

// ---------------------------------------------------------------------------
// English, byte for byte as before
// ---------------------------------------------------------------------------

/**
 * sha256 of each USA fixture below, rendered by the renderer as it stood before
 * the language work (main at 889a270), captured on 24 Sep 2026. A USA invoice's
 * PDF is hashed at Generate and compared again at Email and at the Xero
 * attachment, so the English output must not move by a byte. If a deliberate
 * change to the renderer moves these, replace them in the same commit and say
 * why: every USA invoice generated before it will then fail that comparison.
 *
 * Hashed with the /CreationDate value set aside. jsPDF writes that stamp in the
 * process's own time zone (D:20260903010000+01'00' in London, 000000-00'00' in
 * UTC), so raw hashes captured on one machine failed in CI, which runs in UTC as
 * Netlify does. Every other byte is still compared. Before the stamp was set
 * aside, the raw hashes matched the old renderer in the zone they were taken in.
 */
const GOLDEN = {
  numbered: 'ebf4b6f5ecee346305aa2583d96889849a2d506d51f53239d1979b3072486ebc',
  draft: 'a832b221b16122124a778107a188d964dec5aed4f0a8e0e6e20f95211b5bac47',
  splitCollected: 'c65a69fed8538110ef9c087a0cee2e12f43097f4dc1ca5584a59deb9ef196757',
}

/** The PDF's bytes with the time-zone-dependent creation stamp replaced by a constant. */
const stampless = (bytes: Buffer) =>
  Buffer.from(bytes.toString('latin1').replace(/\/CreationDate \(D:[^)]*\)/, '/CreationDate (D:STAMP)'), 'latin1')

const US_REMIT: RemittanceDetails = {
  accountName: 'Echo Barrier USA LLC', bankName: 'A Bank', bankAddress: ['1 Bank St', 'New York'],
  routingNumber: '000000000', accountNumber: '111111111', ein: null,
}
const US_HEADER: InvoiceDocumentHeaderRow = {
  invoice_number: 'EBUS26-0001', holding_reference: 'USI2026-00010',
  invoice_date: '2026-09-03', due_date: '2026-10-03', currency: 'USD',
  company_name: 'Apex', customer_po_number: '11304',
  delivery_city: 'Los Angeles', delivery_state: 'CA', delivery_zip: '90066',
  delivery_street: '5310 Beethoven St', delivery_country: 'US',
  delivery_location: null, delivery_requested_by: null, is_collection: false,
  billing_name: 'Apex Technology, Inc', billing_line1: '1200 Wilshire Blvd', billing_line2: null,
  billing_city: 'Los Angeles', billing_region: 'CA', billing_postal_code: '90017',
  billing_country: 'USA', billing_email: 'ap@apex.example',
  subtotal: 100, shipping_total: 0, tax_total: 10, total: 110, taxjar_response: null,
}
const US_LINES: InvoiceDocumentLineRow[] = [
  { line_key: 'L1', name: 'H8', description: null, quantity: 1, unit_price: 100, line_total: 100,
    is_shipping: false, ship_from_depot: 'US-BAL', tax_amount: 10, combined_tax_rate: 0.1, sort_order: 0 },
]

// A draft with nothing filled in: no dates, no company, no bank, an EIN, an
// unrated freight line, a site label and a requester.
const US_DRAFT_REMIT: RemittanceDetails = {
  accountName: 'Echo Barrier USA LLC', bankName: null, bankAddress: [],
  routingNumber: null, accountNumber: null, ein: '00-0000000',
}
const US_DRAFT_HEADER: InvoiceDocumentHeaderRow = {
  ...US_HEADER,
  invoice_number: null, holding_reference: 'USI2026-00990', invoice_date: null, due_date: null,
  company_name: null, customer_po_number: null,
  delivery_street: '100 Example Ave', delivery_city: 'Sampletown', delivery_state: 'CA', delivery_zip: '90001',
  delivery_location: 'Yard 7', delivery_requested_by: 'Pat Example',
  billing_name: null, billing_line1: null, billing_city: null, billing_region: null,
  billing_postal_code: null, billing_country: null, billing_email: null,
}
const US_DRAFT_LINES: InvoiceDocumentLineRow[] = [
  { line_key: 'G1', name: 'H9', description: 'Acoustic barrier, sample text', quantity: 4, unit_price: 250, line_total: 1000,
    is_shipping: false, ship_from_depot: 'US-SBD', tax_amount: 95, combined_tax_rate: 0.095, sort_order: 1 },
  { line_key: 'F1', name: 'LTL Freight', description: null, quantity: 1, unit_price: 180, line_total: 180,
    is_shipping: true, ship_from_depot: 'US-SBD', tax_amount: 0, combined_tax_rate: null, sort_order: 0 },
]

// Collected, from two depots, with TaxJar's jurisdictions: every other English
// label the renderer has.
const US_SPLIT_REMIT: RemittanceDetails = {
  accountName: 'Echo Barrier USA LLC', bankName: 'Sample Bank', bankAddress: ['2 Example Plaza', 'Suite 3', 'Chicago IL'],
  routingNumber: '000000001', accountNumber: '222222222', ein: null,
}
const nj = (taxable: number, lineTax: number, shipTax: number) => ({
  tax: {
    rate: 0.06625, taxable_amount: taxable, freight_taxable: true,
    jurisdictions: { city: 'NEWARK', county: 'ESSEX', state: 'NJ' },
    breakdown: {
      line_items: [{ tax_collectable: lineTax, state_amount: lineTax, state_sales_tax_rate: 0.06625 }],
      shipping: { tax_collectable: shipTax, state_amount: shipTax, state_sales_tax_rate: 0.06625 },
    },
  },
})
const US_SPLIT_HEADER: InvoiceDocumentHeaderRow = {
  ...US_HEADER,
  invoice_number: 'EBUS26-0999', holding_reference: 'USI2026-00991',
  invoice_date: '2026-09-15', due_date: '2026-10-30', company_name: 'Northwind Sample Co',
  customer_po_number: 'PO-TEST-1', delivery_street: '9 Sample Rd', delivery_city: 'Newark', delivery_state: 'NJ',
  delivery_zip: '07102', delivery_location: null, delivery_requested_by: 'Sam Sample', is_collection: true,
  billing_name: 'Northwind Sample Co', billing_line1: '5 Invented Way', billing_line2: 'Floor 2',
  billing_city: 'Newark', billing_region: 'NJ', billing_postal_code: '07103', billing_country: 'USA',
  taxjar_response: [
    { depot: 'US-BAL', request: {}, response: nj(1100, 66.25, 6.63) },
    { depot: 'US-SBD', request: {}, response: nj(550, 33.13, 3.31) },
  ],
}
const US_SPLIT_LINES: InvoiceDocumentLineRow[] = [
  { line_key: 'A1', name: 'H20', description: null, quantity: 2, unit_price: 500, line_total: 1000,
    is_shipping: false, ship_from_depot: 'US-BAL', tax_amount: 66.25, combined_tax_rate: 0.06625, sort_order: 0 },
  { line_key: 'A2', name: 'Freight', description: null, quantity: 1, unit_price: 100, line_total: 100,
    is_shipping: true, ship_from_depot: 'US-BAL', tax_amount: 6.63, combined_tax_rate: 0.06625, sort_order: 1 },
  { line_key: 'B1', name: 'H20', description: null, quantity: 1, unit_price: 500, line_total: 500,
    is_shipping: false, ship_from_depot: 'US-SBD', tax_amount: 33.13, combined_tax_rate: 0.06625, sort_order: 2 },
  { line_key: 'B2', name: 'Freight', description: null, quantity: 1, unit_price: 50, line_total: 50,
    is_shipping: true, ship_from_depot: 'US-SBD', tax_amount: 3.31, combined_tax_rate: 0.06625, sort_order: 3 },
]

async function renderUsa(
  header: InvoiceDocumentHeaderRow,
  lines: InvoiceDocumentLineRow[],
  remittance: RemittanceDetails,
  paymentTerms: string | null,
  documentId: string,
  createdAt: string,
  letterhead: boolean,
  language?: DocumentLanguage,
) {
  const document = buildInvoiceDocument(header, lines, { remittance, paymentTerms, ...(language ? { language } : {}) })
  const pdf = await buildInvoicePdf({
    document,
    sellerLines: SELLER_ADDRESS_LINES,
    ...(letterhead ? { sellerPhone: SELLER_PHONE, sellerEmail: SELLER_EMAIL, locale: 'en-US' } : {}),
    documentId,
    createdAt: new Date(createdAt),
  })
  return sha(stampless(Buffer.from(pdf.output('arraybuffer'))))
}

describe('an English invoice is byte for byte what it was before', () => {
  for (const language of [undefined, 'en'] as const) {
    const how = language ? 'asked for in English' : 'with no language given'
    it(`a numbered USA invoice, ${how}`, async () => {
      expect(await renderUsa(US_HEADER, US_LINES, US_REMIT, 'Net 30', '79fe6d34-1e0b-4990-9c2b-627874c1a0f5', '2026-09-03T00:00:00Z', false, language)).toBe(GOLDEN.numbered)
    })
    it(`a USA draft preview, ${how}`, async () => {
      expect(await renderUsa(US_DRAFT_HEADER, US_DRAFT_LINES, US_DRAFT_REMIT, null, 'bbbbbbbb-2222-4333-8444-555555555555', '2026-09-10T00:00:00Z', true, language)).toBe(GOLDEN.draft)
    })
    it(`a collected USA order from two depots, ${how}`, async () => {
      expect(await renderUsa(US_SPLIT_HEADER, US_SPLIT_LINES, US_SPLIT_REMIT, 'The 30th of the following month', 'cccccccc-3333-4444-8555-666666666666', '2026-09-15T00:00:00Z', true, language)).toBe(GOLDEN.splitCollected)
    })
  }
})

// ---------------------------------------------------------------------------
// Which language, and for whom
// ---------------------------------------------------------------------------

describe('only France has a choice', () => {
  it('France offers English, Français and Español; the USA offers nothing', () => {
    expect(documentLanguagesFor(invoicingProfile('EB-FRANCE'))).toEqual(['en', 'fr', 'es'])
    expect(documentLanguagesFor(invoicingProfile('EB-USA'))).toEqual(['en'])
    expect(documentLanguagesFor(null)).toEqual(['en'])
  })

  it('a USA invoice prints in English whatever its column says', () => {
    expect(invoiceLanguage(invoicingProfile('EB-USA'), 'fr')).toBe('en')
    expect(invoiceLanguage(invoicingProfile('EB-FRANCE'), 'es')).toBe('es')
    expect(invoiceLanguage(invoicingProfile('EB-FRANCE'), 'de')).toBe('en')
    expect(invoiceLanguage(invoicingProfile('EB-FRANCE'), undefined)).toBe('en')
    expect(documentLanguage('fr')).toBe('fr')
    expect(documentLanguage('FR')).toBe('en')
    expect(documentLanguage(null)).toBe('en')
  })

  it('the render reads the invoice language through that clamp, never a fresh lookup', () => {
    const src = read('src/app/actions/invoicing/document-data.ts')
    expect(src).toContain('language: invoiceLanguage(profile, invoice.document_language)')
  })
})

describe('the default comes from the deal\'s quote language', () => {
  it('fr is French, es is Spanish, anything else English', () => {
    for (const value of ['fr', 'FR', ' fr ', 'fr-ca', 'fr-FR', 'fr_FR']) expect(languageFromHubSpot(value), value).toBe('fr')
    for (const value of ['es', 'ES', 'es-mx', 'es-ES']) expect(languageFromHubSpot(value), value).toBe('es')
    for (const value of ['en', 'en-gb', 'de', 'pt', 'it', 'french', 'esp', '', null, undefined, 42]) {
      expect(languageFromHubSpot(value), String(value)).toBe('en')
    }
  })

  const q = (id: string, status: string | null, language: string | null, createdAt: string | null): DealQuote => ({ id, status, language, createdAt })

  it('takes the newest PUBLISHED quote, not a newer draft nobody was sent', () => {
    const chosen = pickAcceptedQuote([
      q('101', 'APPROVAL_NOT_NEEDED', 'fr', '2026-09-01T10:00:00Z'),
      q('102', 'DRAFT', 'es', '2026-09-05T10:00:00Z'),
      q('100', 'APPROVED', 'en', '2026-08-01T10:00:00Z'),
    ])
    expect(chosen?.id).toBe('101')
  })

  it('falls back to the newest quote of any status when none was published, and to nothing when there is none', () => {
    expect(pickAcceptedQuote([q('7', 'DRAFT', 'es', '2026-09-02T00:00:00Z'), q('8', 'REJECTED', 'fr', '2026-09-01T00:00:00Z')])?.id).toBe('7')
    expect(pickAcceptedQuote([])).toBeNull()
  })

  it('never depends on the order HubSpot lists the quotes in', () => {
    const quotes = [
      q('99', 'APPROVAL_NOT_NEEDED', 'fr', '2026-09-01T00:00:00Z'),
      q('100', 'APPROVAL_NOT_NEEDED', 'es', '2026-09-01T00:00:00Z'),
      q('98', 'APPROVAL_NOT_NEEDED', 'en', null),
    ]
    expect(pickAcceptedQuote(quotes)?.id).toBe('100')
    expect(pickAcceptedQuote([...quotes].reverse())?.id).toBe('100')
  })
})

/** A HubSpot that answers the two reads the default makes, and records them. */
function fakeHubSpot(opts: {
  assocStatus?: number
  quoteIds?: string[]
  quoteStatus?: number
  quotes?: { id: string; hs_language: string | null; hs_status: string | null; hs_createdate: string | null }[]
  throws?: boolean
}) {
  const calls: { url: string; method: string; body: string | null }[] = []
  const reply = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body })
  const fetcher = async (url: string, init?: { method?: string; body?: string }) => {
    calls.push({ url, method: init?.method ?? 'GET', body: init?.body ?? null })
    if (opts.throws) throw new Error('network down')
    if (url.includes('/associations/quotes')) {
      return reply(opts.assocStatus ?? 200, { results: (opts.quoteIds ?? []).map((id) => ({ toObjectId: Number(id) })) })
    }
    if (url.endsWith('/crm/v3/objects/quotes/batch/read')) {
      return reply(opts.quoteStatus ?? 200, {
        results: (opts.quotes ?? []).map(({ id, ...properties }) => ({ id, properties })),
      })
    }
    throw new Error(`unexpected call ${url}`)
  }
  return { fetcher: fetcher as unknown as Parameters<typeof readDealQuoteLanguage>[1], calls }
}

describe('reading the quote language from HubSpot when an invoice is opened', () => {
  it('asks for the deal\'s quotes and then their language, status and date', async () => {
    const hs = fakeHubSpot({
      quoteIds: ['5001', '5002'],
      quotes: [
        { id: '5001', hs_language: 'es', hs_status: 'APPROVAL_NOT_NEEDED', hs_createdate: '2026-09-10T08:00:00Z' },
        { id: '5002', hs_language: 'fr', hs_status: 'DRAFT', hs_createdate: '2026-09-12T08:00:00Z' },
      ],
    })
    const result = await readDealQuoteLanguage('900000000001', hs.fetcher)
    expect(result).toEqual({ language: 'es', source: 'quote', quoteId: '5001', hsLanguage: 'es' })
    expect(hs.calls[0].url).toBe('https://api.hubapi.com/crm/v4/objects/deals/900000000001/associations/quotes?limit=500')
    expect(hs.calls[1].method).toBe('POST')
    expect(JSON.parse(hs.calls[1].body ?? '{}')).toEqual({
      properties: ['hs_language', 'hs_status', 'hs_createdate'],
      inputs: [{ id: '5001' }, { id: '5002' }],
    })
  })

  it('a German or English quote gives English', async () => {
    const hs = fakeHubSpot({
      quoteIds: ['6001'],
      quotes: [{ id: '6001', hs_language: 'de', hs_status: 'APPROVAL_NOT_NEEDED', hs_createdate: '2026-09-10T08:00:00Z' }],
    })
    expect(await readDealQuoteLanguage('900000000002', hs.fetcher)).toMatchObject({ language: 'en', source: 'quote', hsLanguage: 'de' })
  })

  it('no quote on the deal gives English', async () => {
    const hs = fakeHubSpot({ quoteIds: [] })
    expect(await readDealQuoteLanguage('900000000003', hs.fetcher)).toEqual({
      language: 'en', source: 'no_quote', quoteId: null, hsLanguage: null,
    })
    expect(hs.calls).toHaveLength(1)
  })

  it('a HubSpot failure gives English and says why, and never throws', async () => {
    expect(await readDealQuoteLanguage('900000000004', fakeHubSpot({ assocStatus: 503 }).fetcher)).toMatchObject({
      language: 'en', source: 'unreadable', error: 'quote associations answered 503',
    })
    expect(await readDealQuoteLanguage('900000000005', fakeHubSpot({ quoteIds: ['1'], quoteStatus: 429 }).fetcher)).toMatchObject({
      language: 'en', source: 'unreadable', error: 'quote read answered 429',
    })
    expect(await readDealQuoteLanguage('900000000006', fakeHubSpot({ throws: true }).fetcher)).toMatchObject({
      language: 'en', source: 'unreadable', error: 'network down',
    })
  })

  it('refuses anything that is not a deal id before calling HubSpot', async () => {
    const hs = fakeHubSpot({})
    expect(await readDealQuoteLanguage('../quotes', hs.fetcher)).toMatchObject({ language: 'en', source: 'unreadable' })
    expect(hs.calls).toHaveLength(0)
  })
})

describe('dates are written the way the language writes them', () => {
  it('French, Spanish and English from France, and the USA unchanged', () => {
    expect(formatDocumentDate('2026-09-24', 'fr', 'fr-FR')).toBe('24 septembre 2026')
    expect(formatDocumentDate('2026-10-01', 'fr', 'fr-FR')).toBe('1er octobre 2026')
    expect(formatDocumentDate('2026-09-24', 'es', 'fr-FR')).toBe('24 de septiembre de 2026')
    expect(formatDocumentDate('2026-09-24', 'en', 'fr-FR')).toBe('24 September 2026')
    expect(formatDocumentDate('2026-09-24', 'en', 'en-US')).toBe('September 24, 2026')
    expect(formatDocumentDate(null, 'fr', 'fr-FR')).toBeNull()
    expect(formatDocumentDate('not a date', 'es', 'fr-FR')).toBe('not a date')
    expect(dateLocaleFor('en', 'en-US')).toBe('en-US')
    expect(dateLocaleFor('en', 'fr-FR')).toBe('en-GB')
    expect(dateLocaleFor('fr', 'fr-FR')).toBe('fr-FR')
    expect(dateLocaleFor('es', 'fr-FR')).toBe('es-ES')
  })

  it('never prints a character Helvetica cannot draw', () => {
    for (const language of DOCUMENT_LANGUAGES) {
      for (const iso of ['2026-01-01', '2026-05-03', '2026-12-31']) {
        expect(formatDocumentDate(iso, language, 'fr-FR')).not.toMatch(/[\u202F\u00A0]/)
      }
    }
  })
})
