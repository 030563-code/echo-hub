/**
 * The OBJEDNÁVKOVÝ LIST, as a PDF.
 *
 * Same shape as bamida-po-pdf.ts: pure, jsPDF imported dynamically so it stays
 * out of the bundle until something renders, every input an argument.
 *
 * NO PRICES ANYWHERE, by construction: SupplierSpec carries none, so there is
 * nothing here to strip and nothing that a missing cost.view could leak.
 *
 * 🔴 Two faults were found on the live document on 17 Sep 2026 and both are
 * fixed here rather than worked around:
 *
 *  1. THE SLOVAK WAS WRONG, not merely ugly. The core Helvetica jsPDF ships is
 *     CP1252, which has no caron letters, so "podľa" printed as "pod>a" and
 *     "Čierna" as "ierna" on the sheet the factory builds from. Everything now
 *     goes through Liberation Sans (see pdf-font.ts).
 *  2. TEXT RAN OFF THE PAGE. Every heading, address and note was drawn with a
 *     bare doc.text() and no width, so anything long simply carried on past the
 *     paper. Nothing is drawn here without a width now, and `flow` adds a page
 *     before it would write into the bottom margin instead of after.
 *
 * Column widths are stated rather than left to autoTable, so a long value
 * wraps inside its cell at a width this file chose and not at one that depends
 * on what the other rows happened to contain.
 *
 * ORDER OF THE PAGE, 21 Sep 2026: summary, packing, then the detail. Jozef
 * asked for it through Martin, and he is right. The document used to open on a
 * material table for the first model and put the pallet count on the last page,
 * so nobody could see what the whole order was without reading all of it.
 */

import type { SupplierSpec } from '@/lib/supplier-spec'
import { registerUnicodeFont } from '@/lib/pdf-font'
import { drawEbLogo } from '@/lib/eb-logo'

const qty = (v: number) => (Number.isInteger(v) ? String(v) : String(Number(v.toFixed(3))))

/** A4 in millimetres, and the frame every element is laid out inside. */
const MARGIN = 14
const PAGE_W = 210
const PAGE_H = 297
const CONTENT_W = PAGE_W - MARGIN * 2
/** Last line of body text before the page-number footer. */
const BODY_BOTTOM = PAGE_H - 18

/** Label column of the specification table, and the value column that fills the rest. */
const SPEC_LABEL_W = 46
const SPEC_VALUE_W = CONTENT_W - SPEC_LABEL_W

const finalY = (doc: unknown, fallback: number) =>
  (doc as { lastAutoTable?: { finalY?: number } }).lastAutoTable?.finalY ?? fallback

export async function buildSupplierSpecPdf(spec: SupplierSpec): Promise<import('jspdf').jsPDF> {
  const { default: jsPDF } = await import('jspdf')
  const autoTable = (await import('jspdf-autotable')).default
  const doc = new jsPDF()
  const font = registerUnicodeFont(doc)

  const set = (size: number, weight: 'normal' | 'bold' = 'normal') => {
    doc.setFont(font, weight)
    doc.setFontSize(size)
  }

  let y = 0
  /** Reserve `height` mm of vertical space, starting a new page if it will not fit. */
  const flow = (height: number) => {
    if (y + height > BODY_BOTTOM) {
      doc.addPage()
      y = 20
    }
    return y
  }
  /**
   * Draw wrapped text and advance past it. NOTHING is drawn without a width:
   * that is the whole reason the old document ran off the paper.
   */
  const write = (text: string | string[], size: number, weight: 'normal' | 'bold' = 'normal', width = CONTENT_W) => {
    set(size, weight)
    const lines = doc.splitTextToSize(Array.isArray(text) ? text.join('\n') : text, width) as string[]
    const lineHeight = size * 0.42
    flow(lines.length * lineHeight)
    doc.text(lines, MARGIN, y)
    y += lines.length * lineHeight
    return lines.length
  }

  // ---------------------------------------------------------------- heading
  // The wordmark sits in the top-left corner, clear of the centred title: 40mm
  // wide ends at 54mm and the title starts past 75mm. Dean, 18 Sep 2026: "Add
  // the echobarrier logo to the PO for branding".
  drawEbLogo(doc, MARGIN, 8, 40)
  set(16, 'bold')
  doc.text('OBJEDNÁVKOVÝ LIST', PAGE_W / 2, 16, { align: 'center', maxWidth: CONTENT_W })
  set(10, 'bold')
  doc.text(`MANUFACTURING SPECIFICATION ${spec.specNumber}`, PAGE_W / 2, 22, {
    align: 'center',
    maxWidth: CONTENT_W,
  })

  // Supplier and buyer side by side, each inside its own half so a long address
  // line wraps rather than running into the other column.
  const colW = CONTENT_W / 2 - 4
  const rightX = MARGIN + CONTENT_W / 2 + 4
  set(9, 'bold')
  doc.text('Supplier', MARGIN, 34)
  doc.text('Buyer', rightX, 34)
  set(9, 'normal')
  const supplierLines = doc.splitTextToSize(
    [spec.supplier.name, ...spec.supplier.address].join('\n'),
    colW,
  ) as string[]
  const buyerLines = doc.splitTextToSize(
    [spec.buyer.name, ...spec.buyer.address, `Tax: ${spec.buyer.taxNumber}`].join('\n'),
    colW,
  ) as string[]
  doc.text(supplierLines, MARGIN, 39)
  doc.text(buyerLines, rightX, 39)

  y = 39 + Math.max(supplierLines.length, buyerLines.length) * 4 + 5
  write(`Date: ${spec.date}`, 9)
  if (spec.destination) write(`Destination: ${spec.destination}`, 9)
  y += 6

  // ---------------------------------------------------------------- summary
  // Jozef Šidík through Martin, 21 Sep 2026: "He want some summary of full
  // order on top of documents. For example h9 -350pcs / v2 - 5pcs / cs- 5 pcs.
  // Than he want packing information under that summary part. And after we can
  // put that detailed order with all specification of materials etc."
  //
  // So the document now answers the two questions a person opening it actually
  // has first, in that order: what am I making, and how does it go out. The
  // per-product detail follows, unchanged. Nothing new is computed here: the
  // same products and the same packing block, read in the order he asked for.
  const totalUnits = spec.products.reduce((a, p) => a + p.quantity, 0)
  const totalPallets = spec.products.reduce((a, p) => a + p.pallets, 0)
  autoTable(doc, {
    startY: y,
    margin: { left: MARGIN, right: MARGIN },
    head: [['Model', 'Product', 'Quantity', 'Pallets']],
    body: spec.products.map((p) => [p.model, p.name, `${qty(p.quantity)} pcs`, qty(p.pallets)]),
    foot: spec.products.length > 1 ? [['', 'Total', `${qty(totalUnits)} pcs`, qty(totalPallets)]] : undefined,
    styles: { font, fontSize: 10, overflow: 'linebreak' },
    headStyles: { font, fontStyle: 'bold', fillColor: [40, 40, 40] },
    footStyles: { font, fontStyle: 'bold', fillColor: [235, 235, 235], textColor: [0, 0, 0] },
    columnStyles: {
      0: { cellWidth: 30 },
      1: { cellWidth: CONTENT_W - 30 - 30 - 22 },
      2: { cellWidth: 30, halign: 'right' },
      3: { cellWidth: 22, halign: 'right' },
    },
  })
  y = finalY(doc, y + 20) + 6

  // ---------------------------------------------------------------- packing
  // Second, because that is where he asked for it. It used to be the last thing
  // on the last page, after every material table.
  flow(34)
  autoTable(doc, {
    startY: y,
    margin: { left: MARGIN, right: MARGIN },
    head: [['Packing and finishing', '']],
    body: [
      ['Pallets', qty(spec.packing.pallets)],
      ['Pallet covers', qty(spec.packing.palletCovers)],
      ['Metal frames for pallets', qty(spec.packing.metalFrames)],
      // Only shown when NO product carried a specification. Where a spec exists
      // its own Graphics row says what is printed, and repeating "Standard"
      // underneath would contradict it.
      ...(spec.products.every((p) => p.specRows.length === 0)
        ? ([['Printing', spec.printing]] as [string, string][])
        : []),
    ],
    styles: { font, fontSize: 9, overflow: 'linebreak' },
    headStyles: { font, fontStyle: 'bold', fillColor: [40, 40, 40] },
    columnStyles: { 0: { cellWidth: CONTENT_W - 40 }, 1: { cellWidth: 40, halign: 'right' } },
  })
  y = finalY(doc, y + 20) + 8

  // ---------------------------------------------------------------- products
  // The detail, under a heading of its own so the summary above plainly ends.
  flow(14)
  write('Detailed specification', 12, 'bold')
  y += 3

  for (const product of spec.products) {
    // Keep the heading with at least the first rows of its table rather than
    // stranding a product name alone at the foot of a page.
    flow(30)
    write(`${product.name}  ${qty(product.quantity)} units`, 11, 'bold')
    y += 1
    write(
      `Model ${product.model} · ${product.packSize} per pallet · ${product.pallets} pallet${product.pallets === 1 ? '' : 's'}`,
      9,
    )
    y += 3

    if (product.materials.length) {
      autoTable(doc, {
        startY: y,
        margin: { left: MARGIN, right: MARGIN },
        head: [['Code', 'Material', 'Per barrier', 'Total']],
        body: product.materials.map((m) => [m.code, m.description, qty(m.perUnit), qty(m.total)]),
        styles: { font, fontSize: 9, overflow: 'linebreak', cellWidth: 'wrap' },
        headStyles: { font, fontStyle: 'bold', fillColor: [40, 40, 40] },
        columnStyles: {
          0: { cellWidth: 30 },
          1: { cellWidth: CONTENT_W - 30 - 26 - 26 },
          2: { cellWidth: 26, halign: 'right' },
          3: { cellWidth: 26, halign: 'right' },
        },
      })
      y = finalY(doc, y + 20) + 8
    }

    // The manufacturing specification. Rows come resolved from the builder, so
    // a row Juraj added by hand in the Hub prints exactly like one the Hub knew
    // about, and nothing here needs to know which is which.
    if (product.specRows.length) {
      autoTable(doc, {
        startY: y,
        margin: { left: MARGIN, right: MARGIN },
        head: [[`Specification: ${product.model}`, '']],
        body: product.specRows.map((r) => [r.label, r.value]),
        styles: { font, fontSize: 8, cellPadding: 1.4, overflow: 'linebreak' },
        headStyles: { font, fontStyle: 'bold', fillColor: [90, 90, 90] },
        columnStyles: { 0: { cellWidth: SPEC_LABEL_W }, 1: { cellWidth: SPEC_VALUE_W } },
      })
      y = finalY(doc, y + 20) + 4
    }

    if (product.bullets.length) {
      autoTable(doc, {
        startY: y,
        margin: { left: MARGIN, right: MARGIN },
        head: [['Specific requirements']],
        body: product.bullets.map((b) => [`•  ${b}`]),
        styles: { font, fontSize: 8, cellPadding: 1.4, overflow: 'linebreak' },
        headStyles: { font, fontStyle: 'bold', fillColor: [90, 90, 90] },
        columnStyles: { 0: { cellWidth: CONTENT_W } },
      })
      y = finalY(doc, y + 20) + 4
    }

    // 🔴 WHO SIGNED IT OFF IS NOT PRINTED. Dean, 17 Sep 2026, seeing "Specification confirmed by
    // Operations on 2026-09-17. Read from template": "Please remove these on the client facing
    // Document not needed at all."
    //
    // He is right, and the gate is what made it redundant. The line existed to warn the factory
    // off a sheet nobody had checked, back when an unconfirmed specification could still be sent.
    // Since sendManufacturingPoToBamida refuses an unconfirmed one, they can only ever receive a
    // signed document, so the warning warns of nothing and the name is our own bookkeeping.
    // Whether a specification is confirmed, and who by, is on the order page and in the editor.
    //
    // This line stays, because it is addressed to THEM and not to us: a product block with no
    // requirements on it reads as "nothing special about this one" to whoever is building it, and
    // that is not what an empty specification means.
    if (product.specRows.length === 0 && product.bullets.length === 0) {
      doc.setTextColor(150, 60, 0)
      write(`No manufacturing specification held for ${product.model}.`, 7.5)
      doc.setTextColor(0, 0, 0)
      y += 7
    }
  }

  // A multi-page build sheet that does not say how many pages it has is a build
  // sheet somebody works half of.
  const pages = doc.getNumberOfPages()
  for (let page = 1; page <= pages; page += 1) {
    doc.setPage(page)
    set(7.5, 'normal')
    doc.setTextColor(120, 120, 120)
    doc.text(`${spec.specNumber}`, MARGIN, PAGE_H - 10)
    doc.text(`Page ${page} of ${pages}`, PAGE_W - MARGIN, PAGE_H - 10, { align: 'right' })
    doc.setTextColor(0, 0, 0)
  }

  return doc
}

export function supplierSpecPdfFilename(spec: SupplierSpec): string {
  return `Specification_${spec.specNumber}.pdf`
}
