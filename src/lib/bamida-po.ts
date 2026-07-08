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

// Barriers per pallet (from the Bamida spec sheet: H9 = 9×70). Default 70.
const PACK_SIZE: Record<string, number> = {
  H9: 70, H9W: 70, 'H9X 2.1W': 70, 'H9X 1.5W': 70, H10: 70, H10HercBlack: 70, H8: 70,
}
const DEFAULT_PACK = 70

const PALLET_COVER_EUR = 19 // "Pallet COVERs"
const METAL_FRAME_EUR = 85 // product code 1781 "Metal Frames for Pallets"
const PRINT_TAX = 20 // printing taxed 20% (PO-00001385)

// Fallback used only if po_suppliers can't be read (graceful degradation). The
// live supplier block comes from po_suppliers (code 'BAMIDA, s.r.o.').
const DEFAULT_SUPPLIER: BamidaSupplier = {
  name: 'BAMIDA, s.r.o.',
  address: ['Košická 28', '080 01 Prešov', 'Slovakia'],
  taxNumber: 'SK2022392372',
}
const BUYER = {
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

export function buildBamidaPo(po: SroPoBom, isoDate: string, supplier: BamidaSupplier = DEFAULT_SUPPLIER): BamidaPo {
  const lines: BamidaPoLine[] = []
  let pallets = 0

  for (const l of po.lines) {
    if (!l.model_code) continue
    pallets += Math.ceil(l.quantity / (PACK_SIZE[l.model_code] ?? DEFAULT_PACK))
    if (l.bamida_man_eur > 0) {
      lines.push(mkLine(manCode(l.model_code), `Bamida Manufacturing cost ${l.model_code}`, l.quantity, l.bamida_man_eur, 0))
    }
    if (l.bamida_print_eur > 0) {
      lines.push(mkLine('PRISTD', 'Printing Standard Barriers', l.quantity, l.bamida_print_eur, PRINT_TAX))
    }
  }

  if (pallets > 0) {
    lines.push(mkLine('Pallet COVERs', 'covers for pallets', pallets, PALLET_COVER_EUR, 0))
    lines.push(mkLine('1781', 'Metal Frames for Pallets', pallets, METAL_FRAME_EUR, 0))
  }

  // mkLine always sets numeric values here (this is the priced build path);
  // the null branch is only ever reached after stripBamidaPo.
  const subtotal = round2(lines.reduce((s, l) => s + (l.amount ?? 0), 0))
  const tax = round2(lines.reduce((s, l) => s + ((l.amount ?? 0) * (l.taxRate ?? 0)) / 100, 0))

  return {
    poNumber: po.po_number,
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
