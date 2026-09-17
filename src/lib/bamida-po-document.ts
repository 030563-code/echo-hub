import 'server-only'

/**
 * The supplier purchase order document, rendered from a PO id.
 *
 * Dean, 17 Sep 2026: "the PO that is from SRO to BAMIDA should have the format
 * that is currently in the Bill Of Materials Bamida PO." So the SRO_TO_SUPPLIER
 * leg no longer prints the generic three-tier document. It prints the same
 * thing the Bill of Materials page has always shown and the manufacturer
 * already downloads: buildBamidaPo, priced from the parent order's exploded
 * bill of materials, in buildBamidaPoPdf's layout.
 *
 * One builder for all three places that need it (the Bill of Materials page
 * builds its own from a BOM it already holds; this is for the two that start
 * from a purchase order id), so the factory and the office are looking at the
 * same document rather than two that drift.
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
import { buildBamidaPo, type BamidaSupplier } from '@/lib/bamida-po'
import { buildBamidaPoPdf } from '@/lib/bamida-po-pdf'
import { displayPoNumber } from '@/lib/po-number'

/** Why a document could not be made. The caller turns this into words, because
 *  the factory reads its refusals in Slovak and the office reads them in English. */
export type BamidaPoDocumentRefusal = 'no_parent' | 'no_bom' | 'no_lines'

export type BamidaPoDocumentResult =
  | { ok: true; filename: string; base64: string }
  | { ok: false; reason: BamidaPoDocumentRefusal }

export async function renderBamidaPoDocument(poId: string): Promise<BamidaPoDocumentResult> {
  const admin = createAdminClient()

  const { data: po } = await admin
    .from('purchase_orders')
    .select('po_number, parent_po_id')
    .eq('id', poId)
    .maybeSingle<{ po_number: string | null; parent_po_id: string | null }>()
  // The bill of materials hangs off the PARENT order, which is what carries the
  // exploded lines the document is priced from.
  if (!po?.parent_po_id) return { ok: false, reason: 'no_parent' }

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

  const document = buildBamidaPo(bom, new Date().toISOString().slice(0, 10), supplier, po.po_number)
  if (document.lines.length === 0) return { ok: false, reason: 'no_lines' }

  const pdf = await buildBamidaPoPdf(document)
  const bytes = Buffer.from(pdf.output('arraybuffer') as ArrayBuffer)
  // Not bamidaPoPdfFilename: that one leads with the manufacturer's name, and
  // nothing on their side of the Hub carries it. The order number is what both
  // sides recognise anyway.
  return {
    ok: true,
    filename: `Purchase-order-${displayPoNumber(po.po_number)}.pdf`,
    base64: bytes.toString('base64'),
  }
}
