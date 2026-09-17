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
    y = ((doc as unknown as { lastAutoTable?: { finalY?: number } }).lastAutoTable?.finalY ?? y + 20) + 8

    // The manufacturing specification, which is what Juraj asked for. Only the
    // fields the Hub actually holds are printed: a blank row on a factory
    // document reads as "no requirement" and that is not what an empty database
    // column means.
    const s = product.spec
    if (s) {
      const pair = (a: string | null, b: string | null) =>
        [a, b].filter(Boolean).join(' · ') || null
      const rows: [string, string][] = []
      const add = (label: string, value: string | null) => {
        if (value) rows.push([label, value])
      }
      add('Dimensions', s.dimensions)
      add('PVC', pair(pair(s.pvcType, s.pvcColour), s.pvcRal ? `RAL ${s.pvcRal}` : null))
      add('Mesh (sieťka)', pair(s.meshType, s.meshColour))
      add('Goretex', pair(s.goretexType, s.goretexColour))
      add('Infill (materiál výplne)', pair(s.infillType, s.infillDimensions))
      add('Thread (nite)', pair(s.threadType, s.threadColour))
      add('Reflective strips', pair(s.reflectiveType, s.reflectiveColour))
      add('Rings (krúžky)', s.rings)
      add('Buckles (pracky)', s.buckles)
      add('Graphics', s.graphicsPrint)
      add('Pallet type', s.palletType)
      add('Frame (konštrukcia)', s.construction)
      add('Pallet height', s.maxPalletHeight)
      add('Pack (balenie)', s.packConfig)
      add('Include (pribaliť)', s.includeWithOrder)

      if (rows.length) {
        autoTable(doc, {
          startY: y,
          head: [[`Specification — ${product.model}`, '']],
          body: rows,
          styles: { fontSize: 8, cellPadding: 1.4 },
          headStyles: { fillColor: [90, 90, 90] },
          columnStyles: { 0: { cellWidth: 46 } },
        })
        y = ((doc as unknown as { lastAutoTable?: { finalY?: number } }).lastAutoTable?.finalY ?? y + 20) + 4
      }

      const bullets = [...s.graphicsNotes, ...s.specificRequirements]
      if (bullets.length) {
        autoTable(doc, {
          startY: y,
          head: [['Specific requirements']],
          body: bullets.map((b) => [`•  ${b}`]),
          styles: { fontSize: 8, cellPadding: 1.4 },
          headStyles: { fillColor: [90, 90, 90] },
        })
        y = ((doc as unknown as { lastAutoTable?: { finalY?: number } }).lastAutoTable?.finalY ?? y + 20) + 4
      }

      // 🔴 Said on the document itself, not just in the database. An unconfirmed
      // spec was read off one historic order and nobody has signed it off as the
      // standing values for this model.
      doc.setFontSize(7.5)
      doc.setTextColor(150, 60, 0)
      doc.text(
        s.confirmed
          ? `Specification confirmed. Source: ${s.sourceDocument}.`
          : `SPECIFICATION NOT YET CONFIRMED — read from ${s.sourceDocument}. Check before building.`,
        14,
        y,
      )
      doc.setTextColor(0, 0, 0)
      doc.setFontSize(9)
      y += 8
    } else {
      doc.setFontSize(7.5)
      doc.setTextColor(150, 60, 0)
      doc.text(`No manufacturing specification held for ${product.model}.`, 14, y)
      doc.setTextColor(0, 0, 0)
      doc.setFontSize(9)
      y += 8
    }

    if (y > 250) {
      doc.addPage()
      y = 20
    }
  }

  autoTable(doc, {
    startY: y,
    head: [['Packing and finishing', '']],
    body: [
      ['Pallets', qty(spec.packing.pallets)],
      ['Pallet covers', qty(spec.packing.palletCovers)],
      ['Metal frames for pallets', qty(spec.packing.metalFrames)],
      // Only shown when NO product carried a specification. Where a spec exists
      // its own Graphics row says what is printed, and repeating "Standard"
      // underneath would contradict it.
      ...(spec.products.every((p) => p.spec === null)
        ? ([['Printing', spec.printing]] as [string, string][])
        : []),
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
