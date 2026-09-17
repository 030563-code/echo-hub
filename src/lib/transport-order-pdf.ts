/**
 * The transport order, as a PDF. The -2 document.
 *
 * Dean, 17 Sep 2026: one s.r.o. order, three documents behind it. This is the
 * third, and it says on paper exactly what the email to the forwarder says: the
 * same shipment request, the same parties, the same cargo.
 *
 * It BOOKS NOTHING. Printing a transport order is not sending one. Nothing in
 * this file, or anything that calls it, writes to Cargo Partner, which is a
 * standing rule and not an implementation detail.
 *
 * Same shape as the other two document renderers: pure, jsPDF imported
 * dynamically so it stays out of the bundle until something renders, every
 * input an argument. No prices anywhere: a transport order carries cargo, not
 * money, so there is nothing here a missing cost.view could leak.
 */

import {
  OFFICE_IN_CHARGE,
  PICKUP_PARTIES,
  SHIPPER,
  palletsForQuantity,
  type CargoDraft,
} from '@/lib/cargo-request'

export interface TransportOrder {
  orderNumber: string
  date: string
  draft: CargoDraft
}

const qty = (v: number | null | undefined) => String(Number(v ?? 0))

export async function buildTransportOrderPdf(order: TransportOrder): Promise<import('jspdf').jsPDF> {
  const { default: jsPDF } = await import('jspdf')
  const autoTable = (await import('jspdf-autotable')).default
  const doc = new jsPDF()
  const W = doc.internal.pageSize.width
  const d = order.draft
  const pickup = PICKUP_PARTIES[d.pickup_from]

  doc.setFont('helvetica', 'bold')
  doc.setFontSize(16)
  doc.text('TRANSPORT ORDER', W / 2, 16, { align: 'center' })
  doc.setFontSize(10)
  doc.text(`SHIPMENT REQUEST ${order.orderNumber}`, W / 2, 22, { align: 'center' })

  doc.setFontSize(9)
  doc.setFont('helvetica', 'bold')
  doc.text('Collect from', 14, 34)
  doc.text('Shipper and principal', W / 2 + 6, 34)
  doc.setFont('helvetica', 'normal')
  doc.text([pickup.name, `Account ${pickup.account}`, ...pickup.address], 14, 39)
  doc.text([SHIPPER.name, `Account ${SHIPPER.account}`, ...SHIPPER.address], W / 2 + 6, 39)

  doc.setFont('helvetica', 'bold')
  doc.text('Deliver to', 14, 62)
  doc.text('Office in charge', W / 2 + 6, 62)
  doc.setFont('helvetica', 'normal')
  doc.text(
    [d.consignee_name || 'Not recorded', ...(d.consignee_address ? d.consignee_address.split('\n') : [])],
    14,
    67,
  )
  doc.text([OFFICE_IN_CHARGE.name, `Account ${OFFICE_IN_CHARGE.account}`], W / 2 + 6, 67)

  doc.text(`Date: ${order.date}`, 14, 86)

  autoTable(doc, {
    startY: 92,
    head: [['Shipment', '']],
    body: [
      ['General reference', d.general_reference],
      ['Cargo ready', d.cargo_readiness_date],
      ['Modality', `${d.main_modality} / ${d.main_category} / ${d.business_direction}`],
      ['Pieces', `${qty(d.pieces)} x ${d.package_type_code}`],
      ['Description', d.description],
      // Blank rather than a guess: the Incoterm decides who pays the freight,
      // and the forwarder's email says the same thing when it is not set.
      ['Incoterm', d.delivery_term ?? 'To be confirmed by Echo Barrier'],
    ],
    styles: { fontSize: 9 },
    headStyles: { fillColor: [40, 40, 40] },
    columnStyles: { 1: { halign: 'right' } },
  })

  const afterShipment = (doc as unknown as { lastAutoTable?: { finalY?: number } }).lastAutoTable?.finalY ?? 120

  autoTable(doc, {
    startY: afterShipment + 10,
    // No SKU. Dean, 9 Sep 2026: EBH9NA is our own database code and means
    // nothing to a freight forwarder.
    head: [['Product', 'Units', 'Pallets']],
    body: (d.lines ?? []).map((l) => [
      l.product_name ?? '',
      qty(l.quantity),
      qty(l.pallets ?? palletsForQuantity(l.quantity)),
    ]),
    styles: { fontSize: 9 },
    headStyles: { fillColor: [40, 40, 40] },
    columnStyles: { 1: { halign: 'right' }, 2: { halign: 'right' } },
  })

  if (d.notes?.trim()) {
    const afterCargo = (doc as unknown as { lastAutoTable?: { finalY?: number } }).lastAutoTable?.finalY ?? 160
    doc.setFont('helvetica', 'bold')
    doc.text('Note from Echo Barrier', 14, afterCargo + 12)
    doc.setFont('helvetica', 'normal')
    doc.text(doc.splitTextToSize(d.notes.trim(), W - 28), 14, afterCargo + 17)
  }

  return doc
}
