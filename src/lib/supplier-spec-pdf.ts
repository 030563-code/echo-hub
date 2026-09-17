/**
 * The OBJEDNÁVKOVÝ LIST, as a PDF.
 *
 * Same shape as bamida-po-pdf.ts: pure, jsPDF imported dynamically so it stays
 * out of the bundle until something renders, every input an argument. That is
 * what lets it run on the server for the factory's download and in the browser
 * for the office's, and produce the same document either way.
 *
 * NO PRICES ANYWHERE, by construction: SupplierSpec carries none, so there is
 * nothing here to strip and nothing that a missing cost.view could leak.
 */

import type { SupplierSpec } from '@/lib/supplier-spec'

const qty = (v: number) => (Number.isInteger(v) ? String(v) : String(Number(v.toFixed(3))))

export async function buildSupplierSpecPdf(spec: SupplierSpec): Promise<import('jspdf').jsPDF> {
  const { default: jsPDF } = await import('jspdf')
  const autoTable = (await import('jspdf-autotable')).default
  const doc = new jsPDF()
  const W = doc.internal.pageSize.width

  doc.setFont('helvetica', 'bold')
  doc.setFontSize(16)
  doc.text('OBJEDNÁVKOVÝ LIST', W / 2, 16, { align: 'center' })
  doc.setFontSize(10)
  doc.text(`MANUFACTURING SPECIFICATION ${spec.specNumber}`, W / 2, 22, { align: 'center' })

  doc.setFontSize(9)
  doc.setFont('helvetica', 'bold')
  doc.text('Supplier', 14, 34)
  doc.text('Buyer', W / 2 + 6, 34)
  doc.setFont('helvetica', 'normal')
  doc.text([spec.supplier.name, ...spec.supplier.address], 14, 39)
  doc.text([spec.buyer.name, ...spec.buyer.address, `Tax: ${spec.buyer.taxNumber}`], W / 2 + 6, 39)
  doc.text(`Date: ${spec.date}`, 14, 64)
  if (spec.destination) doc.text(`Destination: ${spec.destination}`, 14, 69)

  let y = spec.destination ? 79 : 74

  for (const product of spec.products) {
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(11)
    doc.text(`${product.name}  -  ${qty(product.quantity)} units`, 14, y)
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(9)
    doc.text(
      `Model ${product.model} · ${product.packSize} per pallet · ${product.pallets} pallet${product.pallets === 1 ? '' : 's'}`,
      14,
      y + 5,
    )

    autoTable(doc, {
      startY: y + 9,
      head: [['Code', 'Material', 'Per barrier', 'Total']],
      body: product.materials.map((m) => [m.code, m.description, qty(m.perUnit), qty(m.total)]),
      styles: { fontSize: 9 },
      headStyles: { fillColor: [40, 40, 40] },
      columnStyles: { 2: { halign: 'right' }, 3: { halign: 'right' } },
    })
    y = ((doc as unknown as { lastAutoTable?: { finalY?: number } }).lastAutoTable?.finalY ?? y + 20) + 12
  }

  autoTable(doc, {
    startY: y,
    head: [['Packing and finishing', '']],
    body: [
      ['Pallets', qty(spec.packing.pallets)],
      ['Pallet covers', qty(spec.packing.palletCovers)],
      ['Metal frames for pallets', qty(spec.packing.metalFrames)],
      ['Printing', spec.printing],
    ],
    styles: { fontSize: 9 },
    headStyles: { fillColor: [40, 40, 40] },
    columnStyles: { 1: { halign: 'right' } },
  })

  return doc
}

export function supplierSpecPdfFilename(spec: SupplierSpec): string {
  return `Specification_${spec.specNumber}.pdf`
}
