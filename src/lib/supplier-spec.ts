import type { SroPoBom } from '@/lib/erp-types'
import { BUYER, DEFAULT_SUPPLIER, type BamidaSupplier } from '@/lib/bamida-po'
import { packSizeFor } from '@/lib/pack-size'

/**
 * The OBJEDNÁVKOVÝ LIST: what the manufacturer builds from, with no prices on it.
 *
 * Dean, 17 Sep 2026, after Juraj asked where the purchase order with material
 * composition and printing specifications had gone: "move the price version to
 * -3 then and -1 the specification document."
 *
 * The numbering scheme has said this since 14 September: -1 is the
 * manufacturing order to the supplier (specs), -2 the shipping order to Cargo
 * Partner, -3 the accounting order (priced). The Hub had been printing the
 * priced document as -1 and never producing a -3 at all.
 *
 * The vault note `Echo Barrier/Stocks Prediction Module/EchoHub — SRO Build
 * State (June 2026).md` records the real document from the June meeting:
 * PO-00001385 is a Slovak build-spec sheet with NO prices, NO MAN/PRI codes and
 * NO totals. It carries the product and quantity, the materials, and the
 * packing. Juraj's three PO types from that meeting were "BOM PO
 * (materials/specs/lead-times), Pricing PO (accounting only, workers must NOT
 * see price), Transport/logistics PO". This is the first of those.
 *
 * Pure, so the same document renders on the server for the factory's download
 * and in the browser for the office's.
 */

export interface SupplierSpecMaterial {
  code: string
  description: string
  /** How many go into ONE barrier. Fractional on purpose: half a sheet is half a sheet. */
  perUnit: number
  /** perUnit x the line quantity, which is what has to leave the s.r.o. store. */
  total: number
}

export interface SupplierSpecProduct {
  model: string
  name: string
  quantity: number
  /** Barriers per pallet for this model, and the pallets it makes. */
  packSize: number
  pallets: number
  materials: SupplierSpecMaterial[]
}

export interface SupplierSpecPacking {
  pallets: number
  palletCovers: number
  metalFrames: number
}

export interface SupplierSpec {
  specNumber: string
  date: string
  supplier: BamidaSupplier
  buyer: { name: string; address: string[]; taxNumber: string }
  /** Where the barriers are going. Bamida pack and label to the destination. */
  destination: string | null
  products: SupplierSpecProduct[]
  packing: SupplierSpecPacking
  /** Standard unless somebody tells us otherwise: the Hub holds no other print spec. */
  printing: string
}


/**
 * Bill-of-materials rows that are NOT a material somebody picks off a shelf:
 * inbound transport recharges and the Group slitting fee. They belong in the
 * cost build-up and would be noise, or worse a wrong instruction, on a sheet
 * that says what to put into a barrier.
 *
 * A HEURISTIC on the code, like the pack sizes and the packaging prices before
 * it. 🔴 Confirm the list with Juraj before this reaches the factory.
 */
const NON_MATERIAL = /(-TRNS|^GRP-SLTF$)/i

/** The one print specification the Hub can express today. There is no colour,
 *  artwork or position field anywhere in either database, so this says what is
 *  true rather than inventing a spec. */
export const STANDARD_PRINTING = 'Standard'

const round3 = (v: number) => Math.round(v * 1000) / 1000

export function buildSupplierSpec(
  po: SroPoBom,
  isoDate: string,
  supplier: BamidaSupplier = DEFAULT_SUPPLIER,
  specNumber: string = '',
  destination: string | null = null,
): SupplierSpec {
  const products: SupplierSpecProduct[] = []
  let pallets = 0

  for (const line of po.lines) {
    if (!line.model_code) continue
    const packSize = packSizeFor(line.model_code)
    const linePallets = Math.ceil(line.quantity / packSize)
    pallets += linePallets

    products.push({
      model: line.model_code,
      name: line.product_name ?? line.model_code,
      quantity: line.quantity,
      packSize,
      pallets: linePallets,
      materials: line.components
        .filter((c) => !NON_MATERIAL.test(c.code))
        .map((c) => ({
          code: c.code,
          description: c.desc ?? c.code,
          perUnit: round3(c.qty),
          total: round3(c.qty * line.quantity),
        })),
    })
  }

  return {
    specNumber,
    date: isoDate,
    supplier,
    buyer: BUYER,
    destination,
    products,
    packing: { pallets, palletCovers: pallets, metalFrames: pallets },
    printing: STANDARD_PRINTING,
  }
}
