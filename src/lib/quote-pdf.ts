/**
 * Pure PDF builder for a customer-facing quote. No DOM/window/fetch/clock
 * access — every fact it prints is supplied by the caller, so it renders
 * identically in the browser (preview/download) and in plain Node (tests,
 * scripts). jsPDF and jspdf-autotable are imported dynamically inside
 * buildQuotePdf() to keep them out of the initial bundle, same as before
 * this was extracted out of the React component.
 *
 * Layout matches a real HubSpot-native Echo Barrier quote (Jillian Rocco,
 * 25 June 2026) — see the task brief for the annotated reference. Nothing
 * internal (SKU, depot code, distributor name, template name) is ever
 * printed here; the customer only sees what a rep explicitly typed
 * (comments, line item descriptions) or generic commercial terms.
 */

/**
 * Quote template, which doubles as the tax jurisdiction. These are the values
 * stored in profiles.allowed_quote_templates and picked in the setup dialog.
 */
export type TaxRegion = 'US' | 'CAN'

/**
 * Exact wording supplied by Dean, 2026-08-24. Do not reword these without
 * asking: they are a commercial statement about how the customer will be
 * invoiced, not descriptive copy.
 */
export const TAX_NOTES: Record<TaxRegion, string> = {
  US: 'Federal and state tax will be applied on invoicing where applicable.',
  CAN: 'All taxes will be applied on invoicing.',
}

/**
 * Issuing entity printed in the footer, keyed by the same template that decides
 * the tax wording. Supplied by Dean 2026-08-24.
 *
 * Anything outside US/CAN falls back to the group entity, which is what every
 * quote carried before this split.
 */
export const ENTITY_ADDRESSES: Record<TaxRegion, string[]> = {
  US: [
    'Echo Barrier USA Head Office',
    'Echo Barrier USA LLC',
    '33 North Dearborn',
    'Suite 1000',
    'Chicago',
    'IL 60602',
    'USA',
    'Tel: + 1 (800) 728 9098',
  ],
  CAN: [
    'Echo Barrier Canada',
    'Echo Barrier Canada, Inc',
    '2482 Yonge Street',
    'Suite 4106',
    'Toronto',
    'Ontario M4P 2H5',
    'Canada',
    'Tel: + 1 (800) 728 9098',
  ],
}

export const DEFAULT_ENTITY_ADDRESS: string[] = [
  'Echo Barrier Group',
  '41 Central Chambers',
  'Dame Court',
  'Dublin, Dublin 2',
  'Ireland',
]

/** The footer address for a template, falling back to the group entity. */
export function entityAddressForRegion(region: TaxRegion | undefined): string[] {
  return region ? ENTITY_ADDRESSES[region] : DEFAULT_ENTITY_ADDRESS
}

/**
 * Maps a chosen quote template to its tax wording. allowed_quote_templates is
 * free text in the database, so anything unrecognised prints no tax line rather
 * than guessing a jurisdiction.
 */
export function taxRegionForTemplate(template: string | null | undefined): TaxRegion | undefined {
  const key = template?.trim().toUpperCase()
  return key === 'US' || key === 'CAN' ? key : undefined
}

export interface QuotePdfLineItem {
  name: string
  description?: string
  quantity: number
  unitPrice: number
  total: number
}

export interface QuotePdfInput {
  dealName: string
  quoteReference: string
  /** Caller-supplied so the module never reads the clock itself. */
  createdAt: Date
  companyName?: string
  contactName?: string
  contactEmail?: string
  contactPhone?: string
  salesRep: { name: string; email: string; phone?: string }
  comments?: string
  lineItems: QuotePdfLineItem[]
  grandTotal: number
  /**
   * Which country's tax wording to print under the total. Comes from the quote
   * template the rep picks at setup, deliberately NOT from the sending depot: a
   * US rep can sell a Canadian job, and the depot stays optional until
   * acceptance whereas the template is mandatory before generating.
   */
  taxRegion?: TaxRegion
  /**
   * The Echo Barrier wordmark as a data URL. Passed in rather than imported so
   * this module stays pure and free of the ~48KB base64 string: the browser
   * fetches /logo-quote.png, Node reads it off disk. When absent the header
   * falls back to type, so a fetch failure costs the logo and not the quote.
   */
  logoDataUrl?: string
}

const MARGIN = 14
const NAME_COLOR: [number, number, number] = [40, 40, 40]
const NAME_SIZE = 10
const DESC_COLOR: [number, number, number] = [140, 140, 140]
const DESC_SIZE = 8
const HEADING_COLOR: [number, number, number] = [40, 55, 75]
const BODY_TEXT_COLOR: [number, number, number] = [90, 90, 90]
const BORDER_COLOR: [number, number, number] = [210, 210, 210]
const OLIVE: [number, number, number] = [85, 107, 47]
const MS_PER_DAY = 24 * 60 * 60 * 1000
// public/logo-quote.png is 600x115, so the height is pinned to that ratio to
// stop the wordmark stretching if the width is ever retuned.
const LOGO_WIDTH = 58
const LOGO_HEIGHT = LOGO_WIDTH * (115 / 600)
// Wide enough for a seven-figure total set at 12pt bold, so the money column
// never collides with the label to its left.
const TOTALS_AMOUNT_WIDTH = 40

function formatMoney(value: number): string {
  return value.toLocaleString('en-US', { style: 'currency', currency: 'USD' })
}

function formatDate(date: Date): string {
  return date.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
}

export async function buildQuotePdf(input: QuotePdfInput): Promise<import('jspdf').jsPDF> {
  const { default: JsPDF } = await import('jspdf')
  const { default: autoTable } = await import('jspdf-autotable')

  const doc = new JsPDF()
  const pageWidth = doc.internal.pageSize.width
  const pageHeight = doc.internal.pageSize.height

  /** Adds a page and resets the cursor when `needed` mm won't fit before the bottom margin. */
  const ensureSpace = (y: number, needed: number): number => {
    if (y + needed > pageHeight - MARGIN) {
      doc.addPage()
      return MARGIN + 10
    }
    return y
  }

  // --- Wordmark ---
  // The artwork already carries the "Environmentally Sound" tagline, so the
  // image replaces both header lines rather than sitting above them.
  let y = 20
  let logoDrawn = false
  if (input.logoDataUrl) {
    try {
      doc.addImage(input.logoDataUrl, 'PNG', MARGIN, 12, LOGO_WIDTH, LOGO_HEIGHT)
      y = 12 + LOGO_HEIGHT
      logoDrawn = true
    } catch (error) {
      // A malformed or truncated data URL must not cost the rep their quote.
      console.error('Quote PDF: logo could not be drawn, falling back to text.', error)
    }
  }
  if (!logoDrawn) {
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(24)
    doc.setTextColor(...OLIVE)
    doc.text('ECHO BARRIER', MARGIN, y)
    y += 5
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(10)
    doc.text('Environmentally Sound', MARGIN, y)
  }

  // --- Deal name as page title ---
  y += 18
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(22)
  doc.setTextColor(0, 0, 0)
  doc.text(input.dealName, MARGIN, y)

  // --- Left block: company / contact — right block: quote meta ---
  y += 12
  let leftY = y
  doc.setFontSize(10)
  if (input.companyName) {
    doc.setFont('helvetica', 'bold')
    doc.setTextColor(0, 0, 0)
    doc.text(input.companyName, MARGIN, leftY)
    leftY += 5
  }
  if (input.contactName) {
    doc.setFont('helvetica', 'bold')
    doc.setTextColor(0, 0, 0)
    doc.text(input.contactName, MARGIN, leftY)
    leftY += 5
  }
  doc.setFont('helvetica', 'normal')
  doc.setTextColor(...BODY_TEXT_COLOR)
  if (input.contactEmail) {
    doc.text(input.contactEmail, MARGIN, leftY)
    leftY += 5
  }
  if (input.contactPhone) {
    doc.text(input.contactPhone, MARGIN, leftY)
    leftY += 5
  }

  let rightY = y
  const rightLines = [
    `Reference: ${input.quoteReference}`,
    `Quote created: ${formatDate(input.createdAt)}`,
    `Quote expires: ${formatDate(new Date(input.createdAt.getTime() + 60 * MS_PER_DAY))}`,
    `Quote created by: ${input.salesRep.name}`,
    input.salesRep.email,
    ...(input.salesRep.phone ? [input.salesRep.phone] : []),
  ]
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(10)
  doc.setTextColor(...BODY_TEXT_COLOR)
  for (const line of rightLines) {
    doc.text(line, pageWidth - MARGIN, rightY, { align: 'right' })
    rightY += 5
  }

  y = Math.max(leftY, rightY) + 8

  // --- Comments box (grows to fit; omitted entirely when empty) ---
  const comments = input.comments?.trim()
  if (comments) {
    const boxX = MARGIN
    const boxWidth = pageWidth - MARGIN * 2
    const innerPad = 6
    const headingHeight = 8
    const bodyLineHeight = 4.6

    doc.setFont('helvetica', 'normal')
    doc.setFontSize(9)
    const bodyLines = doc.splitTextToSize(comments, boxWidth - innerPad * 2) as string[]
    const boxHeight = innerPad * 2 + headingHeight + bodyLines.length * bodyLineHeight

    y = ensureSpace(y, boxHeight + 10)

    doc.setDrawColor(...BORDER_COLOR)
    doc.setLineWidth(0.2)
    doc.rect(boxX, y, boxWidth, boxHeight, 'S')

    doc.setFont('helvetica', 'bold')
    doc.setFontSize(11)
    doc.setTextColor(...HEADING_COLOR)
    doc.text(`Comments from ${input.salesRep.name}`, boxX + innerPad, y + innerPad + 4)

    doc.setFont('helvetica', 'normal')
    doc.setFontSize(9)
    doc.setTextColor(...BODY_TEXT_COLOR)
    let lineY = y + innerPad + 4 + headingHeight
    for (const line of bodyLines) {
      doc.text(line, boxX + innerPad, lineY)
      lineY += bodyLineHeight
    }

    y += boxHeight + 12
  }

  // --- Products & Services table ---
  y = ensureSpace(y, 24)
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(16)
  doc.setTextColor(...HEADING_COLOR)
  doc.text('Products & Services', MARGIN, y)
  y += 8

  const lineItems = input.lineItems
  /** Row index -> description wrapped at 8pt, handed from didParseCell to willDrawCell. */
  const descriptionLines = new Map<number, string[]>()
  const tableRows = lineItems.map((item) => [
    item.name,
    item.quantity,
    formatMoney(item.unitPrice),
    formatMoney(item.total),
  ])

  autoTable(doc, {
    head: [['Item & Description', 'Quantity', 'Unit Price', 'Total']],
    body: tableRows,
    startY: y,
    theme: 'plain',
    margin: { left: MARGIN, right: MARGIN },
    headStyles: {
      fillColor: [255, 255, 255],
      textColor: OLIVE,
      fontStyle: 'bold',
      fontSize: 10,
      halign: 'left',
    },
    bodyStyles: {
      textColor: NAME_COLOR,
      fontSize: NAME_SIZE,
      cellPadding: 6,
    },
    columnStyles: {
      0: { cellWidth: 84 },
      1: { halign: 'center' },
      2: { halign: 'right' },
      3: { halign: 'right' },
    },
    // A row is never split across a page — the description has to stay with
    // the name it belongs to, and this cell is hand-drawn below.
    rowPageBreak: 'avoid',
    // Column 0 shows the item name with its description beneath it in smaller
    // grey type. autoTable styles a whole cell uniformly, so the description
    // is measured and drawn by hand here.
    //
    // The lines are deliberately NOT folded into cell.text: autoTable re-wraps
    // cell.text during width calculation using the cell's own font size (10),
    // which would re-split these 8pt lines against a metric 25% too wide and
    // wrap descriptions that comfortably fit. Instead the wrapped lines are
    // kept aside and the row is given an explicit minimum height to sit in.
    didParseCell: (data) => {
      if (data.section !== 'body' || data.column.index !== 0) return
      const item = lineItems[data.row.index]
      if (!item?.description) return

      const cellWidth = typeof data.cell.styles.cellWidth === 'number' ? data.cell.styles.cellWidth : data.cell.width
      const textWidth = Math.max(10, cellWidth - data.cell.padding('horizontal'))
      data.doc.setFont('helvetica', 'normal')
      data.doc.setFontSize(DESC_SIZE)
      const descLines = data.doc.splitTextToSize(item.description, textWidth) as string[]
      descriptionLines.set(data.row.index, descLines)

      // Reserve the name line plus one slot per description line. The slot
      // height matches what willDrawCell steps by, so the two never disagree.
      const k = data.doc.internal.scaleFactor as number
      const slotLineHeight = (data.cell.styles.fontSize / k) * 1.15
      data.cell.styles.minCellHeight =
        data.cell.padding('vertical') + (1 + descLines.length) * slotLineHeight
    },
    // Column 0 rows with a description skip the default draw entirely (rather
    // than drawing it and painting over it) — jsPDF text is still selectable
    // text in the output, so covering it up would leave two overlapping copies
    // in the document's content stream.
    willDrawCell: (data) => {
      if (data.section !== 'body' || data.column.index !== 0) return undefined
      const item = lineItems[data.row.index]
      const descLines = descriptionLines.get(data.row.index)
      if (!item || !descLines?.length) return undefined

      const { cell } = data
      const k = data.doc.internal.scaleFactor as number
      const pos = cell.getTextPos()
      const baselineOffset = (NAME_SIZE / k) * 0.85
      const slotLineHeight = (cell.styles.fontSize / k) * 1.15

      data.doc.setFont('helvetica', 'normal')
      data.doc.setFontSize(NAME_SIZE)
      data.doc.setTextColor(...NAME_COLOR)
      data.doc.text(item.name, pos.x, pos.y + baselineOffset)

      data.doc.setFontSize(DESC_SIZE)
      data.doc.setTextColor(...DESC_COLOR)
      descLines.forEach((line: string, i: number) => {
        data.doc.text(line, pos.x, pos.y + baselineOffset + slotLineHeight * (i + 1))
      })

      // didDrawCell never fires for a cell whose willDrawCell returned false,
      // so this cell's separator line has to be drawn here instead.
      data.doc.setDrawColor(230, 230, 230)
      data.doc.line(cell.x, cell.y + cell.height, cell.x + cell.width, cell.y + cell.height)

      return false
    },
    didDrawCell: (data) => {
      // Thin separator under every other head/body cell (matches the reference's plain-line table).
      data.doc.setDrawColor(230, 230, 230)
      data.doc.line(data.cell.x, data.cell.y + data.cell.height, data.cell.x + data.cell.width, data.cell.y + data.cell.height)
    },
  })

  const finalY = (doc as unknown as { lastAutoTable?: { finalY?: number } }).lastAutoTable?.finalY ?? y

  // --- Totals ---
  // Labels are right-aligned against the left edge of a fixed-width money
  // column rather than started at a fixed x, so a seven-figure total can never
  // grow leftwards into its own label.
  const amountRight = pageWidth - MARGIN
  const labelRight = amountRight - TOTALS_AMOUNT_WIDTH
  let totalsY = ensureSpace(finalY + 12, 26)
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(10)
  doc.setTextColor(...BODY_TEXT_COLOR)
  doc.text('One-time subtotal', labelRight, totalsY, { align: 'right' })
  doc.text(formatMoney(input.grandTotal), amountRight, totalsY, { align: 'right' })
  totalsY += 8

  doc.setFont('helvetica', 'bold')
  doc.setFontSize(12)
  doc.setTextColor(...HEADING_COLOR)
  doc.text('Total', labelRight, totalsY, { align: 'right' })
  doc.text(formatMoney(input.grandTotal), amountRight, totalsY, { align: 'right' })
  totalsY += 6

  doc.setDrawColor(...BORDER_COLOR)
  doc.line(labelRight - 20, totalsY, amountRight, totalsY)

  // --- Tax note ---
  // Sits directly under the total, because it qualifies that number: the quote
  // is tax-exclusive and tax lands at invoicing.
  const taxNote = input.taxRegion ? TAX_NOTES[input.taxRegion] : undefined
  if (taxNote) {
    totalsY = ensureSpace(totalsY + 7, 8)
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(9)
    doc.setTextColor(...BODY_TEXT_COLOR)
    doc.text(taxNote, amountRight, totalsY, { align: 'right' })
  }

  // --- Purchase terms ---
  let termsY = ensureSpace(totalsY + 16, 30)
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(14)
  doc.setTextColor(...HEADING_COLOR)
  doc.text('Purchase terms', MARGIN, termsY)
  termsY += 8

  const termsText =
    'We trust that our quotation meets your requirements and look forward to receiving your written confirmation and/or purchase order by return. Please note that under no circumstances can we proceed with an order without written confirmation from the client. In the meantime, if you require any further assistance, please do not hesitate to contact our office.\n\nIn the event of an order we would be grateful if you would refer to the quotation number shown above. Many thanks for your ongoing support of our Echo Barrier product line.\n\nYours sincerely,'
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(9)
  doc.setTextColor(...BODY_TEXT_COLOR)
  const termsLines = doc.splitTextToSize(termsText, pageWidth - MARGIN * 2) as string[]
  for (const line of termsLines) {
    termsY = ensureSpace(termsY, 5)
    doc.text(line, MARGIN, termsY)
    termsY += 4.4
  }

  // --- Questions? Contact me ---
  let contactY = ensureSpace(termsY + 10, 28)
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(14)
  doc.setTextColor(...HEADING_COLOR)
  doc.text('Questions? Contact me', MARGIN, contactY)
  contactY += 8

  doc.setFont('helvetica', 'normal')
  doc.setFontSize(10)
  doc.setTextColor(60, 60, 60)
  doc.text(input.salesRep.name, MARGIN, contactY)
  contactY += 5
  doc.text(input.salesRep.email, MARGIN, contactY)
  contactY += 5
  if (input.salesRep.phone) {
    doc.text(input.salesRep.phone, MARGIN, contactY)
    contactY += 5
  }

  // --- Entity address block ---
  // The issuing entity follows the quote template, so a US customer sees the
  // Chicago LLC rather than the Dublin group. Height is reserved from the real
  // line count: the US block is eight lines where the group block was five.
  const addressLines = entityAddressForRegion(input.taxRegion)
  const addressLineHeight = 4.5
  let addressY = ensureSpace(contactY + 10, addressLines.length * addressLineHeight + 4)
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(9)
  doc.setTextColor(...BODY_TEXT_COLOR)
  for (const line of addressLines) {
    doc.text(line, MARGIN, addressY)
    addressY += addressLineHeight
  }

  return doc
}
