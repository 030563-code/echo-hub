import 'server-only'

/**
 * The two documents a supplier order produces, rendered from a PO id.
 *
 * The numbering scheme of 14 Sep 2026 has always said what these are:
 *   EBSRO8001-1  manufacturing order to the supplier  (SPECIFICATION, no prices)
 *   EBSRO8001-2  shipping order to Cargo Partner
 *   EBSRO8001-3  accounting order to the supplier     (PRICED)
 *
 * Until 17 Sep the Hub printed the priced document as -1 and never produced a
 * -3 at all, which is what Juraj was asking about when he wanted "the PO with
 * material composition and printing specifications". Dean: "move the price
 * version to -3 then and -1 the specification document."
 *
 * One order, two documents, two numbers on their faces. No new row and no new
 * leg: -3 is derived from the Group order's number by sroDocumentNumber, which
 * is exactly what that function was written for.
 *
 * The specification carries no prices at all, so it needs no cost.view. The
 * priced one is the accounting document and does.
 *
 * SERVICE-ROLE by necessity: loadSroPoBom and getSupplierByCode read with the
 * caller's client by default, and the factory account holds none of the
 * capabilities can_read_po() wants, so both would come back empty. Only the
 * finished bytes leave. The SroPoBom behind them carries our SRO cost snapshot
 * and never crosses the boundary.
 *
 * The caller does the authorising. This function has no gate of its own and
 * must never be reachable from a 'use server' export directly.
 */

import { createAdminClient } from '@/lib/supabase/admin'
import { loadSroPoBom } from '@/lib/bom'
import { getSupplierByCode } from '@/lib/suppliers'
import { buildBamidaPo, DEFAULT_SUPPLIER, type BamidaSupplier } from '@/lib/bamida-po'
import { buildBamidaPoPdf } from '@/lib/bamida-po-pdf'
import { BUYER } from '@/lib/bamida-po'
import { STANDARD_PRINTING } from '@/lib/supplier-spec'
import { specFromDraft } from '@/lib/po-spec-draft'
import { loadSpecDocument, specActorNames } from '@/lib/po-spec-store'
import { buildSupplierSpecPdf } from '@/lib/supplier-spec-pdf'
import { buildTransportOrderPdf } from '@/lib/transport-order-pdf'
import { loadCargoRequest } from '@/lib/cargo-request-store'
import { displayPoNumber, sroDocumentNumber } from '@/lib/po-number'
import { entityLabel } from '@/lib/depot-constants'

/**
 * The three documents behind one s.r.o. order.
 *
 * Dean, 17 Sep 2026: "the SRO PO on the kanban board appears as EBSR8XXX ...
 * Then when you click on that PO it is split up into manufacturing PO, priced
 * PO, Shipping PO. Shipping PO will be greyed out until the manufacturing is
 * finished." The greying is the caller's; here a shipping document simply has
 * no shipment request behind it until the barriers exist.
 */
export type SupplierDocumentKind = 'specification' | 'priced' | 'shipping'

/** Why a document could not be made. The caller turns this into words, because
 *  the factory reads its refusals in Slovak and the office reads them in English. */
export type SupplierDocumentRefusal = 'no_parent' | 'no_bom' | 'no_lines' | 'no_shipment'

export type SupplierDocumentResult =
  | { ok: true; filename: string; base64: string }
  | { ok: false; reason: SupplierDocumentRefusal }

type Row = {
  po_number: string | null
  parent_po_id: string | null
  from_entity: string | null
  delivery_address: string | null
}

export async function renderSupplierDocument(
  poId: string,
  kind: SupplierDocumentKind,
): Promise<SupplierDocumentResult> {
  const admin = createAdminClient()
  const read = async (id: string) =>
    (
      await admin
        .from('purchase_orders')
        .select('po_number, parent_po_id, from_entity, delivery_address')
        .eq('id', id)
        .maybeSingle<Row>()
    ).data ?? null

  const po = await read(poId)
  // The bill of materials hangs off the PARENT order, which is what carries the
  // exploded lines the document is built from.
  if (!po?.parent_po_id) return { ok: false, reason: 'no_parent' }

  const group = await read(po.parent_po_id)

  if (kind === 'shipping') {
    // -2. Its content is the shipment request, drafted the moment the barriers
    // existed, so there is nothing to print before then. No bill of materials
    // is involved, which is why this answers before that read.
    //
    // 🔴 THIS IS THE ONLY EBSRO<n>-2 THERE IS. Until 17 Sep 2026 a "Raise cargo
    // PO" button also created a real SRO_TO_CARGO purchase order row, and
    // hub_mint_po_number numbers those EBSRO<n>-2 as well: two different objects
    // could carry one number and say different things. Dean: "Shipping document
    // raised from -1 is the real one. Raise Cargo PO should probably be
    // removed." The button and its action are gone. The leg is still understood
    // by the type, the numbering function and the board so that a row from
    // before then would still render, but nothing can make another one.
    const cargo = await loadCargoRequest(poId)
    if (!cargo) return { ok: false, reason: 'no_shipment' }
    const number = sroDocumentNumber(group?.po_number, 'Shipping') ?? po.po_number ?? ''
    const pdf = await buildTransportOrderPdf({
      orderNumber: number,
      date: new Date().toISOString().slice(0, 10),
      draft: cargo.draft,
    })
    return {
      ok: true,
      filename: `Transport-order-${displayPoNumber(number)}.pdf`,
      base64: Buffer.from(pdf.output('arraybuffer') as ArrayBuffer).toString('base64'),
    }
  }

  const bom = await loadSroPoBom(po.parent_po_id, admin)
  if (!bom) return { ok: false, reason: 'no_bom' }

  const supplierRow = await getSupplierByCode('BAMIDA, s.r.o.', admin).catch(() => null)
  const addressLines = (supplierRow?.address ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  const supplier: BamidaSupplier | undefined =
    supplierRow && addressLines.length
      ? { name: supplierRow.name, address: addressLines, taxNumber: supplierRow.tax_number ?? undefined }
      : undefined

  const today = new Date().toISOString().slice(0, 10)

  if (kind === 'priced') {
    // -3, derived from the Group order's number. An order raised before the
    // scheme has no derivable number, so it keeps the one it carries.
    const number = sroDocumentNumber(group?.po_number, 'Accounting') ?? po.po_number
    const document = buildBamidaPo(bom, today, supplier, number)
    if (document.lines.length === 0) return { ok: false, reason: 'no_lines' }
    const pdf = await buildBamidaPoPdf(document)
    return {
      ok: true,
      filename: `Purchase-order-${displayPoNumber(number)}.pdf`,
      base64: Buffer.from(pdf.output('arraybuffer') as ArrayBuffer).toString('base64'),
    }
  }

  // -1, the order's own number: the specification IS the manufacturing order.
  // Where the barriers end up, so the factory can pack and label to it. The
  // depot order at the root of the chain is what knows.
  const root = group?.parent_po_id ? await read(group.parent_po_id) : null
  const destination = root?.from_entity ? entityLabel(root.from_entity) : null

  // WHAT PRINTS IS WHAT WAS SAVED. loadSpecDocument returns the order's own
  // edited document where one exists and a fresh generation where it does not,
  // so the factory and the office are never looking at two different sheets and
  // a confirmed document cannot move underneath the signature that is on it.
  const document = await loadSpecDocument(poId, destination)
  if (!document || document.draft.products.length === 0) return { ok: false, reason: 'no_lines' }

  // The one name on the face of the document, resolved only when there is one
  // to resolve.
  const names = await specActorNames([document.confirmedByUid])
  const approval =
    document.confirmedAt && document.confirmedByUid
      ? {
          at: document.confirmedAt.slice(0, 10),
          by: names.get(document.confirmedByUid) ?? 'Echo Barrier',
        }
      : null

  const spec = specFromDraft(document.draft, {
    specNumber: po.po_number ?? '',
    date: today,
    supplier: supplier ?? DEFAULT_SUPPLIER,
    buyer: BUYER,
    printing: STANDARD_PRINTING,
    approval,
  })
  const pdf = await buildSupplierSpecPdf(spec)
  return {
    ok: true,
    filename: `Specification-${displayPoNumber(po.po_number)}.pdf`,
    base64: Buffer.from(pdf.output('arraybuffer') as ArrayBuffer).toString('base64'),
  }
}
