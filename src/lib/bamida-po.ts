import { palletsFor } from '@/lib/pack-size'
import type { SroPoBom } from '@/lib/erp-types'

// Build the Bamida supplier PO from an exploded SRO order. Per PO-00001385 the
// Bamida PO bills MANUFACTURING (MAN) + PRINTING (PRI) per unit + PACKAGING per
// pallet — NOT the raw BOM components (SRO supplies those). Printing is taxed 20%,
// everything else 0%.
//
// Unit prices come live from the mfg snapshot (bamida_man_eur / bamida_print_eur).
// Pack sizes + packaging prices + code patterns are config seeded from the PDFs —
// confirm with Yuri/Bamida before this leaves localhost.

export interface BamidaPoLine {
  code: string
  description: string
  qty: number
  unit: string
  // Cost fields are null on a price-less "BOM PO" (a user without cost.view).
  price: number | null
  amount: number | null
  taxRate: number | null // percent
}

/** Supplier block for the PO — picked from po_suppliers, or the default below. */
export interface BamidaSupplier {
  name: string
  address: string[]
  taxNumber?: string
}

export interface BamidaPo {
  poNumber: string
  reference: string | null
  date: string // ISO yyyy-mm-dd; caller passes (Date.now unavailable in some contexts)
  supplier: BamidaSupplier
  buyer: { name: string; address: string[]; taxNumber: string }
  lines: BamidaPoLine[]
  subtotal: number | null
  tax: number | null
  total: number | null
  pallets: number
  currency: 'EUR'
  /** false = price-less "BOM PO" (costs stripped for users without cost.view). */
  priced: boolean
}


const PALLET_COVER_EUR = 19 // "Pallet COVERs"
const METAL_FRAME_EUR = 85 // product code 1781 "Metal Frames for Pallets"
const PRINT_TAX = 20 // printing taxed 20% (PO-00001385)

// Fallback used only if po_suppliers can't be read (graceful degradation). The
// live supplier block comes from po_suppliers (code 'BAMIDA, s.r.o.').
export const DEFAULT_SUPPLIER: BamidaSupplier = {
  name: 'BAMIDA, s.r.o.',
  address: ['Košická 28', '080 01 Prešov', 'Slovakia'],
  taxNumber: 'SK2022392372',
}
export const BUYER = {
  name: 'Echo Barrier s.r.o.',
  address: ['Sturova 3/6', 'Kosice', '04001', 'Slovakia'],
  taxNumber: 'SK2023291600',
}

const round2 = (v: number) => Math.round(v * 100) / 100

// MAN code per model (ProductList: MANH9, MANH10, …). Heuristic MAN<model>; the
// real per-model code can be confirmed against the Unleashed product list.
const manCode = (model: string) => `MAN${model.replace(/\s+/g, '')}`

function mkLine(code: string, description: string, qty: number, price: number, taxRate: number): BamidaPoLine {
  return { code, description, qty, unit: 'EA', price: round2(price), amount: round2(qty * price), taxRate }
}

/**
 * The pallets, pallet covers and metal frames somebody signed on the -1
 * specification. Same shape as SupplierSpecPacking, declared here so this
 * module keeps importing nothing from the specification side.
 */
export interface SignedPacking {
  pallets: number
  palletCovers: number
  metalFrames: number
}

/**
 * The Bamida document for one SRO order.
 *
 * `packing` is what was SAVED on the manufacturing specification, when anybody
 * has saved one. Martin, 21 Sep 2026: "I did change packing in manufacturing
 * PO but in price order it fill automatically and I need to change it as
 * well." Until then this document counted pallets from the pack-size table and
 * printed that count as both the covers and the frames, so the two documents
 * for one order disagreed the moment the -1 was edited: EBSRO8001-1 was signed
 * at 8 pallets, 8 covers and 6 frames and the priced order said 7, 7 and 7.
 * The -1 is the editable, signed document and the -3 follows it; nobody edits
 * the same fact twice. With nothing saved the table still decides, which is
 * exactly what the generated -1 would say.
 *
 * `manufacturingPoNumber` is the po_number of the SRO order's manufacturing
 * child (EBSRO8001-1 under EBGRP8001), when one has been raised. It is passed
 * in rather than derived because not every SRO order has one: an order
 * fulfilled from stock has no manufacturing child and never will, and printing
 * EBSRO8001-1 on its document would put a number on paper that no order in the
 * Hub or in Xero carries. With no child the SRO order's own number is used, as
 * it was before the numbering scheme.
 */
export function buildBamidaPo(
  po: SroPoBom,
  isoDate: string,
  supplier: BamidaSupplier = DEFAULT_SUPPLIER,
  manufacturingPoNumber?: string | null,
  packing?: SignedPacking | null,
): BamidaPo {
  const lines: BamidaPoLine[] = []
  let computedPallets = 0

  for (const l of po.lines) {
    if (!l.model_code) continue
    computedPallets += palletsFor(l.model_code, l.quantity)
    if (l.bamida_man_eur > 0) {
      lines.push(mkLine(manCode(l.model_code), `Bamida Manufacturing cost ${l.model_code}`, l.quantity, l.bamida_man_eur, 0))
    }
    if (l.bamida_print_eur > 0) {
      lines.push(mkLine('PRISTD', 'Printing Standard Barriers', l.quantity, l.bamida_print_eur, PRINT_TAX))
    }
  }

  // The signed figures where there are any, the table's where there are none.
  // Covers and frames are separate counts on the specification (a pallet of
  // cutting stations takes a cover and no frame), so each line stands on its
  // own and a signed zero prints no line.
  const pallets = packing ? packing.pallets : computedPallets
  const covers = packing ? packing.palletCovers : computedPallets
  const frames = packing ? packing.metalFrames : computedPallets
  if (covers > 0) lines.push(mkLine('Pallet COVERs', 'covers for pallets', covers, PALLET_COVER_EUR, 0))
  if (frames > 0) lines.push(mkLine('1781', 'Metal Frames for Pallets', frames, METAL_FRAME_EUR, 0))

  // mkLine always sets numeric values here (this is the priced build path);
  // the null branch is only ever reached after stripBamidaPo.
  const subtotal = round2(lines.reduce((s, l) => s + (l.amount ?? 0), 0))
  const tax = round2(lines.reduce((s, l) => s + ((l.amount ?? 0) * (l.taxRate ?? 0)) / 100, 0))

  return {
    // The manufacturing order Bamida receive, when there is one.
    poNumber: manufacturingPoNumber?.trim() || po.po_number,
    reference: po.master_ref,
    date: isoDate,
    supplier,
    buyer: BUYER,
    lines,
    subtotal,
    tax,
    total: round2(subtotal + tax),
    pallets,
    currency: 'EUR',
    priced: true,
  }
}
