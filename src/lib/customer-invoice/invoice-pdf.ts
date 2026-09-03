/**
 * The customer's invoice, as a PDF from the Hub.
 *
 * Dean's decision, 2026-09-03: this document is what the customer receives.
 * Xero is the book of record only and never emails them. It is branded to match
 * the Quotes Hub PDF on purpose, because a customer who accepted a quote should
 * recognise the invoice that follows it.
 *
 * Pure by design. jsPDF is dynamically imported so it stays out of the bundle
 * until something renders, and every input, including the clock, the logo and
 * the remittance block, arrives as an argument. That is what lets the numbers
 * be tested without rendering, and lets the same function run on the server
 * (where the bytes are needed for the email and the Xero attachment) and in a
 * browser preview.
 */

import { formatTaxRate } from './tax-breakdown'
import { remittanceValue } from './seller'
import type { InvoiceDocument } from './invoice-document'

const MARGIN = 14
const HEADING_COLOR: [number, number, number] = [40, 55, 75]
const BODY_TEXT_COLOR: [number, number, number] = [90, 90, 90]
const LABEL_COLOR: [number, number, number] = [140, 140, 140]
const BORDER_COLOR: [number, number, number] = [210, 210, 210]
const OLIVE: [number, number, number] = [85, 107, 47]
const DRAFT_COLOR: [number, number, number] = [200, 120, 40]
/** public/logo.jpg is 1119x215; the height is pinned to that ratio so the
 *  wordmark cannot stretch if the width is ever retuned. */
const LOGO_WIDTH = 58
const LOGO_HEIGHT = LOGO_WIDTH * (215 / 1119)

export interface InvoicePdfInput {
  document: InvoiceDocument
  /** Seller letterhead lines, from seller.ts. */
  sellerLines: readonly string[]
  sellerPhone?: string
  sellerEmail?: string
  /**
   * What makes the render REPRODUCIBLE, and both are required for it.
   *
   * jsPDF stamps a wall-clock /CreationDate and a random /ID into every
   * document, so two renders of identical data are never byte-identical.
   * Verified: back-to-back renders differed only in those two fields. The
   * invoicing flow hashes the PDF at Generate and re-renders at Email to check
   * the customer is getting the document that was checked, and that comparison
   * could never pass while these varied.
   *
   * Pinned from stable values (the invoice id and a date already on the row),
   * so identical data renders identical bytes while a change to the DATA or to
   * the RENDERER still changes them. Weakening the check to a content hash
   * would have lost the second half of that.
   */
  documentId: string
  createdAt: Date
  /**
   * The Echo Barrier wordmark as a data URL. Passed in rather than imported so
   * this module stays free of the base64 string: a browser fetches it, the
   * server reads it off disk. Absent means the header falls back to type, so a
   * read failure costs the logo and not the invoice.
   */
  logoDataUrl?: string
}

function money(value: number, currency: string): string {
  return value.toLocaleString('en-US', { style: 'currency', currency, currencyDisplay: 'narrowSymbol' })
}

/** ISO date to "September 1, 2026", the form a US customer expects. Returns a
 *  dash for a missing date so the label still has something to sit against on a
 *  draft preview. Built and formatted in UTC: these are date-only values, and
 *  local formatting would print the previous day west of Greenwich. */
function formatDate(iso: string | null): string {
  if (!iso) return '—'
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso.trim())
  if (!m) return iso
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])))
  return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
}

/**
 * A PDF /ID is 32 hex characters. Derived from the invoice id so it is stable
 * for a given invoice and different between invoices, which is what the field
 * is for.
 */
function stableFileId(documentId: string): string {
  let hex = ''
  for (let i = 0; i < documentId.length && hex.length < 32; i++) {
    hex += documentId.charCodeAt(i).toString(16).padStart(2, '0')
  }
  return (hex + '0'.repeat(32)).slice(0, 32).toUpperCase()
}

export async function buildInvoicePdf(input: InvoicePdfInput): Promise<import('jspdf').jsPDF> {
  const { document: inv } = input
  const currency = inv.currency || 'USD'
  const { default: JsPDF } = await import('jspdf')
  const { default: autoTable } = await import('jspdf-autotable')

  const doc = new JsPDF()
  // Both pinned before anything is drawn. See the field docs above: without
  // this the same invoice hashes differently every time it is rendered.
  doc.setCreationDate(input.createdAt)
  doc.setFileId(stableFileId(input.documentId))

  const pageWidth = doc.internal.pageSize.width
  const pageHeight = doc.internal.pageSize.height
  const right = pageWidth - MARGIN

  const ensureSpace = (y: number, needed: number): number => {
    if (y + needed > pageHeight - MARGIN) {
      doc.addPage()
      return MARGIN + 10
    }
    return y
  }

  // --- Wordmark ---
  let y = 20
  let logoDrawn = false
  if (input.logoDataUrl) {
    try {
      doc.addImage(input.logoDataUrl, 'JPEG', MARGIN, 12, LOGO_WIDTH, LOGO_HEIGHT)
      y = 12 + LOGO_HEIGHT
      logoDrawn = true
    } catch (error) {
      // A malformed data URL must not cost the customer their invoice.
      console.error('Invoice PDF: logo could not be drawn, falling back to type.', error)
    }
  }
  if (!logoDrawn) {
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(24)
    doc.setTextColor(...OLIVE)
    doc.text('ECHO BARRIER', MARGIN, y)
  }

  // --- Seller letterhead, opposite the wordmark ---
  // Top right rather than the foot of the page. As a footer it was the last
  // thing drawn, so on a long invoice it was pushed onto a second page and the
  // customer got a sheet carrying nothing but our address. A letterhead cannot
  // overflow because nothing above it varies in height.
  {
    const sellerBlock = [
      ...input.sellerLines,
      ...(input.sellerPhone ? [input.sellerPhone] : []),
      ...(input.sellerEmail ? [input.sellerEmail] : []),
    ]
    if (input.document.remittance.ein) sellerBlock.push(`EIN ${input.document.remittance.ein}`)
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(8)
    doc.setTextColor(...BODY_TEXT_COLOR)
    let sellerY = 14
    for (const line of sellerBlock) {
      doc.text(line, right, sellerY, { align: 'right' })
      sellerY += 3.6
    }
  }

  // --- Title, and the draft marking ---
  // A preview rendered before the number is allocated says so in the title and
  // again under the reference. An unnumbered invoice that looks issued is the
  // one mistake this document must not allow.
  y += 18
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(22)
  doc.setTextColor(0, 0, 0)
  doc.text(inv.isDraftReference ? 'Draft invoice' : 'Invoice', MARGIN, y)

  if (inv.isDraftReference) {
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(10)
    doc.setTextColor(...DRAFT_COLOR)
    doc.text('NOT AN INVOICE. Preview only, no number allocated and nothing filed.', MARGIN, y + 6)
    y += 6
  }

  // --- Meta panel: the header row from the design ---
  y += 10
  const metaPairs: [string, string][] = [
    [inv.isDraftReference ? 'DRAFT REFERENCE' : 'INVOICE', inv.reference],
    ['ISSUED', formatDate(inv.issuedOn)],
    // The separator only earns its place when both halves exist. A draft has no
    // due date yet, and "—  ·  Net 30" reads as a broken field rather than as
    // terms that have not been applied to a date.
    ['DUE', [inv.dueOn ? formatDate(inv.dueOn) : null, inv.paymentTerms].filter((p) => p).join('  ·  ') || '—'],
  ]
  if (inv.customerPoNumber) metaPairs.push(['CUSTOMER PO', inv.customerPoNumber])
  // Depots are named by PLACE, never by our internal code (Dean, 2026-09-03).
  // "EX US-BAL" means nothing to a buyer; "Jessup MD" does.
  metaPairs.push([
    'DESPATCHED FROM',
    inv.isSplit
      ? `${inv.shipments.length} shipments, ${inv.shipments.map((s) => s.label).join(' and ')}`
      : (inv.shipments[0]?.label ?? '—'),
  ])

  const boxWidth = pageWidth - MARGIN * 2
  const columns = 3
  const colWidth = boxWidth / columns
  const rows = Math.ceil(metaPairs.length / columns)
  const rowHeight = 13
  const boxHeight = rows * rowHeight + 6

  doc.setDrawColor(...BORDER_COLOR)
  doc.setLineWidth(0.2)
  doc.rect(MARGIN, y, boxWidth, boxHeight, 'S')

  metaPairs.forEach(([label, value], i) => {
    const col = i % columns
    const row = Math.floor(i / columns)
    const x = MARGIN + 5 + col * colWidth
    const cellY = y + 7 + row * rowHeight
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(7)
    doc.setTextColor(...LABEL_COLOR)
    doc.text(label, x, cellY)
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(10)
    doc.setTextColor(0, 0, 0)
    doc.text(doc.splitTextToSize(value, colWidth - 8) as string[], x, cellY + 5)
  })
  y += boxHeight + 8

  // --- Bill to and ship to, side by side ---
  // Both in full. They are routinely different (a head office pays, a site
  // receives), and the delivery address is the one the tax was calculated
  // against, so a customer checking the rate needs to see it.
  {
    const addrColWidth = (pageWidth - MARGIN * 2) / 2
    const blocks: [string, string[]][] = [
      ['BILL TO', inv.billTo.length > 0 ? inv.billTo : [inv.customerName]],
      [inv.isCollection ? 'COLLECTION' : 'SHIP TO', inv.shipTo.length > 0 ? inv.shipTo : ['—']],
    ]
    let tallest = 0
    blocks.forEach(([label, lines], i) => {
      const x = MARGIN + i * addrColWidth
      doc.setFont('helvetica', 'normal')
      doc.setFontSize(7)
      doc.setTextColor(...LABEL_COLOR)
      doc.text(label, x, y)
      doc.setFontSize(10)
      doc.setTextColor(0, 0, 0)
      let lineY = y + 5
      for (const text of lines) {
        for (const wrapped of doc.splitTextToSize(text, addrColWidth - 8) as string[]) {
          doc.text(wrapped, x, lineY)
          lineY += 4.6
        }
      }
      tallest = Math.max(tallest, lineY - y)
    })
    y += tallest + 6
  }

  // --- Lines ---
  // A single-depot invoice is a flat table. A split one groups by shipment,
  // because the two halves went to different jurisdictions and are filed as two
  // separate TaxJar transactions, so presenting them as one list would hide the
  // only thing that makes the tax reconcilable.
  const head = [['DESCRIPTION', 'QTY', 'UNIT', 'NET', 'RATE', 'TAX', 'LINE TOTAL']]
  const body: (string | { content: string; colSpan?: number; styles?: Record<string, unknown> })[][] = []

  for (const shipment of inv.shipments) {
    if (inv.isSplit) {
      const ref = shipment.taxjarTransactionId ? `   ·   TaxJar ${shipment.taxjarTransactionId}` : ''
      body.push([
        {
          content: `${shipment.label}${ref}`,
          colSpan: 7,
          styles: { fontStyle: 'bold', fillColor: [244, 246, 243], textColor: HEADING_COLOR, fontSize: 8 },
        },
      ])
    }
    for (const line of shipment.lines) {
      body.push([
        line.detail ? `${line.description}\n${line.detail}` : line.description,
        String(line.quantity),
        money(line.unitPrice, currency),
        money(line.net, currency),
        // A null rate is "exempt", not zero: in a state that exempts
        // separately stated freight there is no rate to quote.
        line.taxRate === null ? 'exempt' : formatTaxRate(line.taxRate),
        money(line.tax, currency),
        money(line.lineTotal, currency),
      ])
    }
    if (inv.isSplit) {
      body.push([
        { content: `Subtotal, ${shipment.label}`, colSpan: 3, styles: { fontStyle: 'bold' } },
        { content: money(shipment.net, currency), styles: { fontStyle: 'bold' } },
        '',
        { content: money(shipment.tax, currency), styles: { fontStyle: 'bold' } },
        { content: money(shipment.total, currency), styles: { fontStyle: 'bold' } },
      ])
    }
  }

  autoTable(doc, {
    head,
    body,
    startY: y,
    theme: 'plain',
    margin: { left: MARGIN, right: MARGIN },
    headStyles: { fillColor: [255, 255, 255], textColor: OLIVE, fontStyle: 'bold', fontSize: 8, halign: 'left' },
    bodyStyles: { textColor: [40, 40, 40], fontSize: 9, cellPadding: 3 },
    columnStyles: {
      0: { cellWidth: 62 },
      1: { halign: 'right' },
      2: { halign: 'right' },
      3: { halign: 'right' },
      4: { halign: 'right', textColor: BODY_TEXT_COLOR },
      5: { halign: 'right' },
      6: { halign: 'right' },
    },
    rowPageBreak: 'avoid',
  })

  const table = (doc as unknown as { lastAutoTable?: { finalY: number } }).lastAutoTable
  y = (table?.finalY ?? y) + 10

  // --- Totals, and the rate split underneath ---
  y = ensureSpace(y, 60)
  const totalsTop = y
  const totalsLeft = pageWidth / 2
  const label = (text: string, value: string, bold = false, indent = 0) => {
    doc.setFont('helvetica', bold ? 'bold' : 'normal')
    doc.setFontSize(bold ? 11 : 9)
    const tone: [number, number, number] = bold ? [0, 0, 0] : BODY_TEXT_COLOR
    doc.setTextColor(...tone)
    doc.text(text, totalsLeft + indent, y)
    doc.text(value, right, y, { align: 'right' })
    y += bold ? 7 : 5
  }

  label('Taxable net', money(inv.taxableNet, currency))
  if (inv.freight > 0) {
    label(inv.freightIsTaxed ? 'Freight (taxable)' : 'Freight (not taxable)', money(inv.freight, currency))
  }
  label('Sales tax', money(inv.salesTax, currency))
  for (const j of inv.jurisdictions) {
    label(`${j.label} ${formatTaxRate(j.rate)}`, money(j.amount, currency), false, 4)
  }
  doc.setDrawColor(...BORDER_COLOR)
  doc.line(totalsLeft, y, right, y)
  y += 6
  label('Total due', money(inv.totalDue, currency), true)

  // --- Remittance, in the column beside the totals ---
  // Beside rather than below, which is where the design puts it and is also
  // what keeps it on the same page. Underneath the totals it was the last block
  // drawn, so a two-shipment invoice pushed "How to pay" onto a second sheet on
  // its own. The one block that tells a customer how to pay must not be the one
  // that goes missing when an order gets bigger.
  let remitY = totalsTop
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(11)
  doc.setTextColor(...HEADING_COLOR)
  doc.text('How to pay', MARGIN, remitY)
  remitY += 7

  // Headings match the bank's own confirmation letter word for word (Dean,
  // 2026-09-03). An accounts-payable clerk is copying these into a payment
  // form, and a label they recognise from the bank letter is one less thing for
  // them to query.
  const r = inv.remittance
  // Multi-line values, because the bank's address is three lines on the letter
  // and squeezing it onto one ran it straight across into the totals column.
  const remitRows: [string, string[]][] = [
    ['Account Name', [r.accountName]],
    ['Bank', [remittanceValue(r.bankName, 'bank name')]],
    ...(r.bankAddress.length > 0 ? ([['Address', r.bankAddress]] as [string, string[]][]) : []),
    ['Routing Number', [remittanceValue(r.routingNumber, 'routing number')]],
    ['Account No', [remittanceValue(r.accountNumber, 'account number')]],
    // Not a bank detail, but the thing that makes a received payment
    // reconcilable. The handover specifies the invoice number as the reference.
    ['Reference', [inv.reference]],
  ]
  // The remittance owns the left column only. Anything wider collides with the
  // totals sitting opposite it.
  const remitValueX = MARGIN + 30
  const remitValueWidth = totalsLeft - remitValueX - 8
  doc.setFontSize(9)
  for (const [k, values] of remitRows) {
    doc.setFont('helvetica', 'normal')
    doc.setTextColor(...LABEL_COLOR)
    doc.text(k, MARGIN, remitY)
    // An unfilled remittance field prints in the draft colour, so a document
    // that cannot actually be paid is obvious at a glance rather than subtle.
    const tone: [number, number, number] = values[0]?.startsWith('<') ? DRAFT_COLOR : [40, 40, 40]
    doc.setTextColor(...tone)
    for (const value of values) {
      for (const wrapped of doc.splitTextToSize(value, remitValueWidth) as string[]) {
        doc.text(wrapped, remitValueX, remitY)
        remitY += 5
      }
    }
  }
  y = Math.max(y, remitY)

  // --- Where TaxJar decided the sale happened ---
  // Printed because it is the customer's check as much as ours: a rate is only
  // meaningful next to the jurisdiction it came from.
  if (inv.taxDetail.some((t) => t.resolvedPlace !== '')) {
    y = ensureSpace(y + 8, 14)
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(8)
    doc.setTextColor(...LABEL_COLOR)
    for (const detail of inv.taxDetail) {
      if (!detail.resolvedPlace) continue
      const place = inv.shipments.find((sh) => sh.depot === detail.depot)?.label ?? detail.depot
      const prefix = inv.isSplit ? `${place}: ` : ''
      doc.text(`${prefix}Tax jurisdiction ${detail.resolvedPlace}`, MARGIN, y)
      y += 4
    }
  }

  return doc
}

/** The filename the customer sees. */
export function invoicePdfFilename(reference: string): string {
  return `invoice_${reference.replace(/[^A-Za-z0-9._-]/g, '_')}.pdf`
}
