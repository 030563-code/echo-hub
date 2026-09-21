/**
 * From the signed manufacturing specification to the packing list.
 *
 * The -1 specification (po_spec_document.draft) is the only document that says
 * what is actually being built and packed: the models, the quantities Juraj
 * signed, the barriers per pallet, the pallet count, and per model the pallet
 * type, its maximum height, whether it carries a mesh back and its dimensions.
 * Every one of those is a packing list fact, so the packing list is read off
 * the signed document and never off the order lines or the standing model_spec,
 * both of which can move after somebody has signed.
 *
 * Two things come from outside the specification because it does not hold
 * them: the HS code (typed on the order line, else the HS codes tab for the
 * s.r.o. to Group leg) and the number their "PO" column prints, which is the
 * Group order, the s.r.o.'s customer order, exactly as EBG26100 sat on the
 * Jessup list. The hop from an order SKU to a specification model is
 * po_product_catalog.bom_model_code, the same map the bill of materials uses.
 *
 * Pure. The database trip is packing-list-store.ts.
 */

import type { SpecDraft, SpecDraftProduct } from '@/lib/po-spec-draft'
import {
  asGroupCopy,
  buildPackingList,
  type PackingListContact,
  type PackingListDoc,
  type PackingListParty,
  type PackingListProduct,
  type PackingListVariant,
} from '@/lib/despatch/packing-list'
import { packingSize } from '@/lib/despatch/packing-size'

/**
 * The two letterheads, read off PL-A and PL-B USA Jessup 11.09.2026. Constants
 * rather than entities rows because the company registration numbers they
 * print are held on no table, and a packing list without them is not the
 * document the forwarder has been receiving.
 */
export const SRO_LETTERHEAD: PackingListParty = {
  name: 'ECHO BARRIER S.R.O.',
  address: ['Stúrová 3/6', '040 01 Košice, Slovakia'],
  identifiers: ['VAT No. SK2023291600', 'ID: 46241485'],
}

export const GROUP_LETTERHEAD: PackingListParty = {
  name: 'Echo Barrier Group Limited',
  address: ['41 Central Chambers', 'Dame Court', 'Dublin 2', 'Ireland'],
  identifiers: ['Company Reg. No. 616375'],
}

export interface OrderLineForPacking {
  sku: string
  hs_code: string | null
}

export interface PackingSourceInput {
  draft: SpecDraft
  /** The s.r.o. order's own lines: the HS code typed at raise time lives here. */
  lines: readonly OrderLineForPacking[]
  /** po_product_catalog: order SKU to manufacturing model code. */
  modelBySku: ReadonlyMap<string, string | null>
  /** product_hs_codes for the s.r.o. to Group leg, keyed on the order SKU. */
  hsBySku: ReadonlyMap<string, string>
  /** The Group order's number: their "PO" column. */
  poReference: string | null
}

export interface PackingSource {
  products: PackingListProduct[]
  signedPallets: number | null
  /** What the specification could not tell us. Shown in the Hub, printed nowhere. */
  warnings: string[]
}

/** A plain size and nothing else: "1335 x 2050 mm", "( 1793 x 1010mm )". */
const DIMENSIONS = /^\(?\s*(\d{3,4})\s*[x×X]\s*(\d{3,4})\s*mm\s*\)?$/

const clean = (v: string | null | undefined) => (v ?? '').trim().replace(/\s+/g, ' ')

/** The value of the first specification row whose label starts with `label`, or null. */
function rowValue(product: SpecDraftProduct, label: string): string | null {
  const wanted = label.toLowerCase()
  const row = product.specRows.find((r) => r.label.trim().toLowerCase().startsWith(wanted))
  const value = clean(row?.value)
  return value === '' ? null : value
}

/**
 * "Echo Barrier H9 (1335 x 2050 mm)": the name, with the size when the
 * Dimensions row is a plain size. The cutting station's row reads "CS barrier
 * ( tlačový súbor 2500 x 2050mm )", which is the print file and not the
 * product, so it stays a name.
 */
export function productDescription(product: SpecDraftProduct): string {
  const dims = rowValue(product, 'dimensions')
  const m = dims ? DIMENSIONS.exec(dims) : null
  return m ? `${product.name} (${m[1]} x ${m[2]} mm)` : product.name
}

/**
 * Whether this build has a mesh back, which is half a kilogram per H9. A Mesh
 * row with something in it says yes; no row, or a row of dashes (how the
 * templates write "none"), says no.
 */
export function hasMeshBack(product: SpecDraftProduct): boolean {
  const mesh = rowValue(product, 'mesh')
  return mesh !== null && /[\p{L}\d]/u.test(mesh)
}

export function packingSourceFromSpec(input: PackingSourceInput): PackingSource {
  const warnings: string[] = []

  const products: PackingListProduct[] = input.draft.products.map((p) => {
    const palletType = rowValue(p, 'pallet type')
    const size = packingSize(palletType, rowValue(p, 'pallet height'))
    if (!size.footprint) {
      warnings.push(
        `${p.model}: the specification names no pallet size (Pallet type says "${palletType ?? 'nothing'}"), so its packing size prints ${size.height ? 'the height only' : 'blank'}. Put the size on the Pallet type row as width x depth in cm.`,
      )
    }

    const onOrder = input.lines.filter((l) => input.modelBySku.get(l.sku) === p.model)
    if (onOrder.length === 0) {
      warnings.push(
        `${p.model}: no line on the order maps to it (po_product_catalog.bom_model_code), so its HS code cannot be looked up.`,
      )
    }
    const typed = onOrder.map((l) => clean(l.hs_code)).find(Boolean) ?? null
    const onTab = onOrder.map((l) => clean(input.hsBySku.get(l.sku))).find(Boolean) ?? null

    return {
      model: p.model,
      description: productDescription(p),
      quantity: p.quantity,
      packSize: p.packSize,
      hasMesh: hasMeshBack(p),
      hsCode: typed ?? onTab,
      poReference: input.poReference,
      // An empty string prints an empty cell. Null would let the builder print
      // the H9 pallet's size, which is a guess this document must not make.
      packingSize: size.text ?? '',
    }
  })

  return {
    products,
    signedPallets: input.draft.packing.pallets > 0 ? input.draft.packing.pallets : null,
    warnings,
  }
}

/**
 * A party from a stored delivery address. The Hub writes them as
 * "US <dash> Baltimore depot <dash> Capitol Warehouse, 8125 Stayton Drive, ...":
 * the labels before the last dash are the depot's, the address is after it,
 * one line per comma.
 */
export function partyFromDeliveryAddress(
  name: string,
  deliveryAddress: string | null | undefined,
): PackingListParty {
  const tail = clean(deliveryAddress).split(/\s[–—-]\s/).pop() ?? ''
  const address = tail
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  return { name, address }
}

/** Their date: 11/9/26 for 11 September 2026. */
export function documentDateLabel(isoDate: string): string {
  const [y, m, d] = isoDate.split('-').map(Number)
  return `${d}/${m}/${String(y).slice(-2)}`
}

/** Their filename: "PL-A USA Jessup 11.09.2026.pdf". */
export function packingListFilename(
  variant: PackingListVariant,
  destination: string | null,
  isoDate: string,
): string {
  const [y, m, d] = isoDate.split('-')
  return `PL-${variant} ${destination ?? 'shipment'} ${d}.${m}.${y}.pdf`
}

/** What the person despatching types, once, for both copies. */
export interface PackingListForm {
  /** yyyy-mm-dd, the despatch date. It also numbers the pallets by month. */
  date: string
  consignee: PackingListParty
  deliverTo: PackingListParty
  attention: PackingListContact
  incoterms: string | null
  /** This container's first pallet number in the factory's monthly sequence. */
  firstPalletNumber: number
  comments: string | null
}

export interface PackingListAssembly {
  placeOfCollection: string[]
  source: PackingSource
}

/**
 * Both copies from ONE build, so they cannot disagree on a kilogram: the B copy
 * is the A copy on Group letterhead, which is what asGroupCopy exists for.
 */
export function assemblePackingLists(
  input: PackingListAssembly,
  form: PackingListForm,
): { a: PackingListDoc; b: PackingListDoc; warnings: string[] } {
  const a = buildPackingList({
    variant: 'A',
    issuer: SRO_LETTERHEAD,
    date: documentDateLabel(form.date),
    placeOfCollection: input.placeOfCollection,
    consignee: form.consignee,
    deliverTo: form.deliverTo,
    attention: form.attention,
    incoterms: form.incoterms,
    products: input.source.products,
    signedPallets: input.source.signedPallets,
    palletMonth: form.date.slice(0, 7),
    firstPalletNumber: form.firstPalletNumber,
    comments: form.comments,
  })
  const b = asGroupCopy(a, { issuer: GROUP_LETTERHEAD, consignee: form.consignee })
  return { a, b, warnings: [...input.source.warnings, ...a.warnings] }
}

/** What the order page shows before anybody types: the part that does not depend on the form. */
export interface PackingListPreview {
  lines: PackingListDoc['lines']
  /** Pallets the products make; the signed count is shown beside it when they differ. */
  pallets: number
  signedPallets: number | null
  totalNetKg: number
  totalGrossKg: number
  weightsConfirmed: boolean
  warnings: string[]
}

export function previewPackingList(
  input: PackingListAssembly & { consignee: PackingListParty },
  date: string,
): PackingListPreview {
  const { a, warnings } = assemblePackingLists(input, {
    date,
    consignee: input.consignee,
    deliverTo: input.consignee,
    attention: { name: null, phone: null, email: null },
    incoterms: null,
    firstPalletNumber: 1,
    comments: null,
  })
  return {
    lines: a.lines,
    pallets: a.pallets.filter((p) => !p.loose).length,
    signedPallets: input.source.signedPallets,
    totalNetKg: a.totalNetKg,
    totalGrossKg: a.totalGrossKg,
    weightsConfirmed: a.weightsConfirmed,
    warnings,
  }
}
