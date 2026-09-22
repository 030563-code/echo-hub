import 'server-only'

/**
 * The database trip behind a packing list, and the render.
 *
 * SERVICE ROLE by necessity, for the same reason as bamida-po-document.ts:
 * loadSpecDocument and the supplier row read with the caller's client by
 * default, and not every person who may print a packing list holds what those
 * reads want. Only the finished bytes leave. The caller does the authorising;
 * nothing here has a gate of its own and it must never be reachable from a
 * 'use server' export directly.
 *
 * WHAT PRINTS IS WHAT WAS SIGNED. The specification comes through
 * loadSpecDocument, so an order with a saved document packs from that document
 * word for word, and an order with none packs from a fresh generation and the
 * card says so.
 */

import { createAdminClient } from '@/lib/supabase/admin'
import { loadSpecDocument } from '@/lib/po-spec-store'
import { getSupplierByCode } from '@/lib/suppliers'
import { DEFAULT_SUPPLIER } from '@/lib/bamida-po'
import { entityLabel } from '@/lib/depot-constants'
import { modelForSku, modelMaps } from '@/lib/sku-model'
import { orgForDepot } from '@/lib/organisations'
import type { PackingListParty, PackingListVariant } from '@/lib/despatch/packing-list'
import { buildPackingListPdf } from '@/lib/despatch/packing-list-pdf'
import {
  assemblePackingLists,
  packingListFilename,
  packingSourceFromSpec,
  partyFromDeliveryAddress,
  type PackingListForm,
  type PackingSource,
} from '@/lib/despatch/packing-list-source'

export interface PackingListContext {
  poId: string
  poNumber: string
  /** The Group order: what their "PO" column prints. */
  groupPoNumber: string | null
  /** Where the barriers are going, for the filename and the card. */
  destination: string | null
  /** The depot's company at the order's delivery address. A starting point; the person despatching can change it. */
  consignee: PackingListParty
  /** The factory, where the forwarder collects. */
  placeOfCollection: string[]
  /** Bamida's finish date, the natural despatch date to start from. */
  estFinish: string | null
  source: PackingSource
  spec: { saved: boolean; confirmedAt: string | null }
}

/** The order's SKUs to their models, through both tables (sku-model.ts). */
function modelBySkuFor(
  skus: readonly string[],
  catalogueRows: readonly { sku: string; bom_model_code: string | null }[],
  masterRows: readonly { internal_sku: string; bom_model_code: string | null }[],
): Map<string, string | null> {
  const maps = modelMaps(catalogueRows, masterRows)
  return new Map(skus.map((sku) => [sku, modelForSku(sku, maps.catalogue, maps.master)]))
}

type Row = {
  id: string
  po_number: string | null
  leg: string
  parent_po_id: string | null
  from_entity: string | null
  delivery_address: string | null
}

/** Null when this is not a manufacturing order, or it has nothing to pack from. */
export async function loadPackingListContext(poId: string): Promise<PackingListContext | null> {
  const admin = createAdminClient()
  const read = async (id: string) =>
    (
      await admin
        .from('purchase_orders')
        .select('id, po_number, leg, parent_po_id, from_entity, delivery_address')
        .eq('id', id)
        .maybeSingle<Row>()
    ).data ?? null

  const po = await read(poId)
  if (!po || po.leg !== 'SRO_TO_SUPPLIER' || !po.parent_po_id) return null
  const group = await read(po.parent_po_id)
  const root = group?.parent_po_id ? await read(group.parent_po_id) : null
  const destination = root?.from_entity ? entityLabel(root.from_entity) : null

  const spec = await loadSpecDocument(poId, destination)
  if (!spec || spec.draft.products.length === 0) return null

  const [{ data: lines }, { data: catalog }, { data: master }, supplierRow, { data: manufacturing }] = await Promise.all([
    admin.from('purchase_order_lines').select('sku, hs_code').eq('po_id', poId),
    admin.from('po_product_catalog').select('sku, bom_model_code'),
    admin.from('product_code_master').select('internal_sku, bom_model_code'),
    getSupplierByCode('BAMIDA, s.r.o.', admin).catch(() => null),
    admin.from('po_manufacturing').select('est_finish').eq('po_id', poId).maybeSingle<{ est_finish: string | null }>(),
  ])

  const orderLines = ((lines ?? []) as { sku: string; hs_code: string | null }[]).map((l) => ({
    sku: String(l.sku),
    hs_code: l.hs_code,
  }))
  const skus = orderLines.map((l) => l.sku)
  const { data: hsRows } = skus.length
    ? await admin.from('product_hs_codes').select('sku, hs_code').eq('leg', 'SRO_TO_GROUP').in('sku', skus)
    : { data: [] as { sku: string; hs_code: string | null }[] }

  const org = orgForDepot(root?.from_entity)
  const { data: entity } = org
    ? await admin.from('entities').select('legal_name').eq('code', org).maybeSingle<{ legal_name: string | null }>()
    : { data: null }

  const placeOfCollection = (supplierRow?.address ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)

  return {
    poId,
    poNumber: po.po_number ?? '',
    groupPoNumber: group?.po_number ?? null,
    destination,
    consignee: partyFromDeliveryAddress(
      entity?.legal_name ?? destination ?? '',
      root?.delivery_address ?? po.delivery_address,
    ),
    placeOfCollection: placeOfCollection.length ? placeOfCollection : [...DEFAULT_SUPPLIER.address],
    estFinish: manufacturing?.est_finish ?? null,
    source: packingSourceFromSpec({
      draft: spec.draft,
      lines: orderLines,
      modelBySku: modelBySkuFor(
        orderLines.map((l) => l.sku),
        (catalog ?? []) as { sku: string; bom_model_code: string | null }[],
        (master ?? []) as { internal_sku: string; bom_model_code: string | null }[],
      ),
      hsBySku: new Map(
        ((hsRows ?? []) as { sku: string; hs_code: string | null }[])
          .filter((r) => typeof r.hs_code === 'string' && r.hs_code.trim() !== '')
          .map((r) => [r.sku, String(r.hs_code)]),
      ),
      poReference: group?.po_number ?? null,
    }),
    spec: { saved: spec.saved, confirmedAt: spec.confirmedAt },
  }
}

/**
 * One copy as bytes. Stamped with the order and the despatch date so the same
 * inputs render the same bytes, which is what lets anyone compare the A and B
 * copies or verify an emailed one.
 */
export async function renderPackingListPdf(
  context: PackingListContext,
  form: PackingListForm,
  variant: PackingListVariant,
): Promise<{ filename: string; base64: string; warnings: string[] }> {
  const { a, b, warnings } = assemblePackingLists(context, form)
  const pdf = await buildPackingListPdf(variant === 'A' ? a : b, {
    documentId: context.poId,
    createdAt: new Date(`${form.date}T00:00:00Z`),
  })
  return {
    filename: packingListFilename(variant, context.destination, form.date),
    base64: Buffer.from(pdf.output('arraybuffer') as ArrayBuffer).toString('base64'),
    warnings,
  }
}
