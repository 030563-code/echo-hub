/**
 * The Bamida purchase order, as a PDF.
 *
 * Lifted out of the download button in bom/bamida-po-modal.tsx unchanged. It
 * had to move because the same bytes now have to be emailed to Bamida, and
 * bytes that exist only inside a click handler in somebody's browser cannot be
 * attached to anything.
 *
 * Same shape as invoice-pdf.ts: pure, jsPDF imported dynamically so it stays
 * out of the bundle until something renders, every input an argument. That is
 * what lets it run on the server for the email and in the browser for the
 * download, and produce the same document either way.
 */

import type { BamidaPo } from '@/lib/bamida-po'

const eur2 = (v: number) => v.toLocaleString('en-GB', { minimumFractionDigits: 2 })

export async function buildBamidaPoPdf(bamida: BamidaPo): Promise<import('jspdf').jsPDF> {
  const { default: jsPDF } = await import('jspdf')
  const autoTable = (await import('jspdf-autotable')).default
  const doc = new jsPDF()
  const W = doc.internal.pageSize.width
  const priced = bamida.priced

  doc.setFont('helvetica', 'bold')
  doc.setFontSize(16)
  doc.text(priced ? 'OBJEDNÁVKOVÝ LIST' : 'BOM / SPECIFICATION', W / 2, 16, { align: 'center' })
  doc.setFontSize(10)
  doc.text(`${priced ? 'PURCHASE ORDER' : 'BOM'} ${bamida.poNumber}`, W / 2, 22, { align: 'center' })

  doc.setFontSize(9)
  doc.setFont('helvetica', 'bold')
  doc.text('Supplier', 14, 34)
  doc.text('Buyer', W / 2 + 6, 34)
  doc.setFont('helvetica', 'normal')
  doc.text([bamida.supplier.name, ...bamida.supplier.address], 14, 39)
  doc.text([bamida.buyer.name, ...bamida.buyer.address, `Tax: ${bamida.buyer.taxNumber}`], W / 2 + 6, 39)
  // No reference line: bamida.reference is the Hub's master_ref, an internal
  // chain key that means nothing to a supplier.
  doc.text(`Date: ${bamida.date}`, 14, 64)

  const head = priced
    ? [['Ln', 'Code', 'Description', 'Qty', 'Unit', 'Price', 'Amount', 'Tax']]
    : [['Ln', 'Code', 'Description', 'Qty', 'Unit']]
  const body = bamida.lines.map((l, i) => {
    const base = [String(i + 1), l.code, l.description, l.qty.toString(), l.unit]
    return priced
      ? [...base, (l.price ?? 0).toFixed(2), eur2(l.amount ?? 0), `${(l.taxRate ?? 0).toFixed(2)}%`]
      : base
  })

  autoTable(doc, {
    startY: 76,
    head,
    body,
    styles: { fontSize: 9 },
    headStyles: { fillColor: [40, 40, 40] },
    columnStyles: priced ? { 5: { halign: 'right' }, 6: { halign: 'right' }, 7: { halign: 'right' } } : {},
  })

  if (priced) {
    const finalY = (doc as unknown as { lastAutoTable?: { finalY?: number } }).lastAutoTable?.finalY ?? 90
    doc.setFontSize(9)
    doc.text(`SUBTOTAL (EUR)   ${eur2(bamida.subtotal ?? 0)}`, W - 14, finalY + 8, { align: 'right' })
    doc.text(`TAX (EUR)   ${eur2(bamida.tax ?? 0)}`, W - 14, finalY + 14, { align: 'right' })
    doc.setFont('helvetica', 'bold')
    doc.text(`TOTAL INCL. TAX (EUR)   ${eur2(bamida.total ?? 0)}`, W - 14, finalY + 21, { align: 'right' })
  }

  return doc
}

export function bamidaPoPdfFilename(bamida: BamidaPo): string {
  return `${bamida.priced ? 'Bamida' : 'BOM'}_${bamida.poNumber}.pdf`
}
