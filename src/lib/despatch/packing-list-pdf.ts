/**
 * The PACKING LIST, as a PDF.
 *
 * Same shape and the same rules as supplier-spec-pdf.ts: pure, jsPDF imported
 * dynamically so it stays out of the bundle until something renders, every
 * input an argument, nothing drawn without a width, and the Unicode font
 * registered because Kosice, Presov and Kungalv all carry letters that jsPDF's
 * built-in Helvetica prints as the WRONG character rather than as nothing.
 *
 * Laid out to match the document Bamida have been sending for years, because
 * the people who receive it (a forwarder, a customs officer, a warehouse) read
 * it by shape rather than by reading it. Two departures, both deliberate:
 *
 *  - Their header says INCONTERMS. It is INCOTERMS and the Hub spells it
 *    correctly. A misspelling copied on purpose is a misspelling we own.
 *  - The weight table prints an UNCONFIRMED banner while WEIGHTS_CONFIRMED is
 *    false, the same way the manufacturing specification says it has not been
 *    signed. A document that quietly states an unverified weight is worse than
 *    one that says it is unverified.
 *
 * 🔴 columnStyles reach the BODY only. A right-aligned column whose heading and
 * total are set through columnStyles prints the heading left-aligned, which is
 * how the supplier specification shipped a crooked table on 21 Sep 2026. Every
 * right-aligned heading and total here carries its own per-cell style.
 */

import type { PackingListDoc } from '@/lib/despatch/packing-list'
import { registerUnicodeFont } from '@/lib/pdf-font'
import { drawEbLogo } from '@/lib/eb-logo'

/** The wordmark's own green, read out of its palette: #085945. */
const EB_GREEN: [number, number, number] = [8, 89, 69]
const WHITE: [number, number, number] = [255, 255, 255]

const MARGIN = 14
const PAGE_W = 210
const PAGE_H = 297
const CONTENT_W = PAGE_W - MARGIN * 2
const BODY_BOTTOM = PAGE_H - 20

const kg = (v: number) => `${Number.isInteger(v) ? v : Number(v.toFixed(1))} kg`
const num = (v: number) => (Number.isInteger(v) ? String(v) : String(Number(v.toFixed(1))))

const finalY = (doc: unknown, fallback: number) =>
  (doc as { lastAutoTable?: { finalY?: number } }).lastAutoTable?.finalY ?? fallback

/** A right-aligned cell, because columnStyles will not reach a head or foot row. */
const right = (content: string) => ({ content, styles: { halign: 'right' as const } })

/**
 * A PDF /ID is 32 hex characters. Derived from the order so it is stable for a
 * given document and different between documents, which is what the field is
 * for. Lifted from invoice-pdf.ts, which learned it the hard way.
 */
function stableFileId(documentId: string): string {
  let hex = ''
  for (let i = 0; i < documentId.length && hex.length < 32; i++) {
    hex += documentId.charCodeAt(i).toString(16).padStart(2, '0')
  }
  return (hex + '0'.repeat(32)).slice(0, 32).toUpperCase()
}

export interface PackingListPdfStamp {
  /** The order this document belongs to, which seeds the /ID. */
  documentId: string
  /** What /CreationDate says. Pass the order's own date, never `new Date()`. */
  createdAt: Date
}

/**
 * `stamp` is optional only so a caller can render a throwaway preview. Anything
 * that STORES, HASHES, EMAILS or ATTACHES the result must pass it: jsPDF stamps
 * a wall-clock /CreationDate and a RANDOM /ID otherwise, so the same container
 * renders different bytes every time and no two copies can be compared. That is
 * the fault that made emailing a customer invoice impossible until
 * invoice-pdf.ts pinned both, and the A and B copies of a packing list are
 * exactly a pair of documents somebody will want to compare.
 */
export async function buildPackingListPdf(
  pl: PackingListDoc,
  stamp?: PackingListPdfStamp,
): Promise<import('jspdf').jsPDF> {
  const { default: jsPDF } = await import('jspdf')
  const autoTable = (await import('jspdf-autotable')).default
  const doc = new jsPDF()
  // Both pinned before anything is drawn, as in invoice-pdf.ts.
  if (stamp) {
    doc.setCreationDate(stamp.createdAt)
    doc.setFileId(stableFileId(`${stamp.documentId}:${pl.variant}`))
  }
  const font = registerUnicodeFont(doc)

  const set = (size: number, weight: 'normal' | 'bold' = 'normal') => {
    doc.setFont(font, weight)
    doc.setFontSize(size)
  }
  /** A green label bar with white text, the way every block on their sheet opens. */
  const bar = (label: string, x: number, y: number, w: number, h = 5) => {
    doc.setFillColor(...EB_GREEN)
    doc.rect(x, y, w, h, 'F')
    set(7.5, 'bold')
    doc.setTextColor(...WHITE)
    doc.text(label.toUpperCase(), x + 1.5, y + h - 1.5, { maxWidth: w - 3 })
    doc.setTextColor(0, 0, 0)
  }
  /** Draw wrapped lines from a top edge and return the y they ended at. */
  const block = (lines: string[], x: number, y: number, w: number, size = 8) => {
    set(size)
    const wrapped = doc.splitTextToSize(lines.filter(Boolean).join('\n'), w) as string[]
    doc.text(wrapped, x, y)
    return y + wrapped.length * (size * 0.42)
  }

  // ------------------------------------------------------------------ header
  set(13, 'bold')
  doc.text(pl.issuer.name, MARGIN, 18, { maxWidth: CONTENT_W * 0.55 })
  set(20, 'bold')
  doc.setTextColor(...EB_GREEN)
  doc.text('PACKING LIST', PAGE_W - MARGIN, 19, { align: 'right' })
  doc.setTextColor(0, 0, 0)

  const idEnd = block([...pl.issuer.address, ...(pl.issuer.identifiers ?? [])], MARGIN, 24, CONTENT_W * 0.5, 7.5)

  // DATE and PLACE OF COLLECTION, as two labelled cells on the right. The label
  // column is wide enough for "PLACE OF COLLECTION" on ONE line: at 34mm it
  // wrapped to two and the bar clipped the second, which is exactly the class of
  // fault this file's header comment is about.
  const labelW = 40
  const valueW = 40
  const rightX = PAGE_W - MARGIN - (labelW + valueW)
  bar('Date', rightX, 24, labelW)
  block([pl.date], rightX + labelW + 2, 27.8, valueW - 2, 8)
  bar('Place of collection', rightX, 30.5, labelW)
  const placeEnd = block(pl.placeOfCollection, rightX + labelW + 2, 34.3, valueW - 2, 7.5)

  // -------------------------------------------------- consignee / deliver to
  let y = Math.max(idEnd, placeEnd, 42) + 4
  const colW = (CONTENT_W - 8) / 3
  const cols: { label: string; lines: string[] }[] = [
    { label: 'Consignee', lines: [pl.consignee.name, ...pl.consignee.address, ...(pl.consignee.identifiers ?? [])] },
    { label: 'Deliver to', lines: [pl.deliverTo.name, ...pl.deliverTo.address] },
    {
      label: 'Attention to',
      lines: [
        pl.attention.name ? `Name  ${pl.attention.name}` : 'Name  -',
        pl.attention.phone ? `Phone ${pl.attention.phone}` : 'Phone -',
        pl.attention.email ? `Email ${pl.attention.email}` : 'Email -',
      ],
    },
  ]
  let bandBottom = y
  let attentionBottom = y
  cols.forEach((c, i) => {
    const x = MARGIN + i * (colW + 4)
    bar(c.label, x, y, colW)
    const end = block(c.lines, x, y + 8, colW, 7.5)
    bandBottom = Math.max(bandBottom, end)
    if (i === 2) attentionBottom = end
  })

  // Incoterms sits under the ATTENTION column, not under the whole band. Hanging
  // it off the tallest of the three pushed the tables 15mm down the page and
  // sent the comments box onto a second sheet.
  if (pl.incoterms) {
    const x = MARGIN + 2 * (colW + 4)
    bar('Incoterms', x, attentionBottom + 2, colW)
    bandBottom = Math.max(bandBottom, block([pl.incoterms], x, attentionBottom + 10, colW, 8))
  }
  y = bandBottom + 5

  // ------------------------------------------------------- what is in the box
  // Their own column order. The weight column only appears when every line has
  // one, because a half-filled weight column reads as "these items weigh
  // nothing" rather than as "we do not know".
  const showUnitWeight = pl.lines.length > 0 && pl.lines.every((l) => l.unitNetKg !== null)
  const head = showUnitWeight
    ? [['Barrier type', 'HS code', right('Weight per pc'), right('Quantity'), 'Purchase order']]
    : [['Barrier type', 'HS code', right('Quantity'), 'Purchase order']]

  autoTable(doc, {
    startY: y,
    margin: { left: MARGIN, right: MARGIN },
    tableWidth: CONTENT_W,
    styles: { font, fontSize: 8, cellPadding: 2, overflow: 'linebreak', valign: 'middle' },
    headStyles: { font, fontStyle: 'bold', fillColor: EB_GREEN, textColor: WHITE, halign: 'left' },
    head,
    body: pl.lines.map((l) =>
      showUnitWeight
        ? [l.description, l.hsCode ?? '-', right(kg(l.unitNetKg as number)), right(`${l.quantity} pcs`), l.poReference ?? '-']
        : [l.description, l.hsCode ?? '-', right(`${l.quantity} pcs`), l.poReference ?? '-'],
    ),
    columnStyles: showUnitWeight
      ? { 0: { cellWidth: 62 }, 1: { cellWidth: 34 }, 2: { cellWidth: 24 }, 3: { cellWidth: 24 }, 4: { cellWidth: CONTENT_W - 144 } }
      : { 0: { cellWidth: 74 }, 1: { cellWidth: 40 }, 2: { cellWidth: 26 }, 3: { cellWidth: CONTENT_W - 140 } },
  })
  y = finalY(doc, y) + 6

  // ------------------------------------------------------------- the pallets
  if (y > BODY_BOTTOM - 40) {
    doc.addPage()
    y = 20
  }
  autoTable(doc, {
    startY: y,
    margin: { left: MARGIN, right: MARGIN },
    tableWidth: CONTENT_W,
    // Tighter than the upper table on purpose: a container of nine or ten
    // pallets has to fit on ONE sheet with its totals and its comments box, and
    // at cellPadding 2 a nine-pallet list tipped onto a second page.
    styles: { font, fontSize: 8, cellPadding: 1.5, overflow: 'linebreak', valign: 'middle' },
    headStyles: { font, fontStyle: 'bold', fillColor: EB_GREEN, textColor: WHITE, halign: 'left' },
    footStyles: { font, fontStyle: 'bold', fillColor: [235, 235, 235], textColor: [0, 0, 0] },
    head: [['Item #', 'Product description', 'Packing size', right('Weight of item\n(netto/brutto)')]],
    body: pl.pallets.map((p) => [
      p.ref ? `Pallet Ref. No.: ${p.ref}` : '',
      p.description,
      p.packingSize,
      right(p.netKg || p.grossKg ? `${num(p.netKg)} kg / ${num(p.grossKg)} kg` : '-'),
    ]),
    foot: [
      ['', right('TOTAL Weight (NETTO)'), right(num(pl.totalNetKg)), 'kg'],
      ['', right('TOTAL Weight (BRUTTO)'), right(num(pl.totalGrossKg)), 'kg'],
      ['', right('UNITS:'), right(String(pl.units)), pl.units === 1 ? 'pallet' : 'pallets'],
    ],
    columnStyles: {
      0: { cellWidth: 44 },
      1: { cellWidth: CONTENT_W - 44 - 34 - 36 },
      2: { cellWidth: 34 },
      3: { cellWidth: 36, halign: 'right' },
    },
  })
  y = finalY(doc, y) + 3

  // ------------------------------------------------------ comments and caveat
  const tailHeight = 5 + 12 + (pl.weightsConfirmed ? 0 : 7)
  if (y + tailHeight > BODY_BOTTOM) {
    doc.addPage()
    y = 20
  }
  bar('Comments', MARGIN, y, CONTENT_W)
  doc.setDrawColor(200, 200, 200)
  doc.rect(MARGIN, y + 5, CONTENT_W, 12)
  if (pl.comments) block([pl.comments], MARGIN + 2, y + 10, CONTENT_W - 4, 8)
  y += 21

  if (!pl.weightsConfirmed) {
    set(7.5, 'bold')
    doc.setTextColor(150, 60, 0)
    doc.text(
      doc.splitTextToSize(
        'Weights are taken from Echo Barrier s.r.o. packing lists and have not yet been confirmed against a weighbridge.',
        CONTENT_W,
      ) as string[],
      MARGIN,
      y,
    )
    doc.setTextColor(0, 0, 0)
  }

  // ------------------------------------------------------------------ footer
  // On EVERY page. The wordmark only on the last sheet reads as an unbranded
  // continuation page to whoever is handed the second one at a loading bay.
  const pages = doc.getNumberOfPages()
  for (let p = 1; p <= pages; p += 1) {
    doc.setPage(p)
    drawEbLogo(doc, (PAGE_W - 34) / 2, PAGE_H - 17, 34)
    if (pages > 1) {
      set(7)
      doc.setTextColor(120, 120, 120)
      doc.text(`Page ${p} of ${pages}`, PAGE_W - MARGIN, PAGE_H - 8, { align: 'right' })
      doc.setTextColor(0, 0, 0)
    }
  }
  return doc
}
