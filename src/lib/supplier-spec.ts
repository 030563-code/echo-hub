import type { SroPoBom } from '@/lib/erp-types'
import { BUYER, DEFAULT_SUPPLIER, type BamidaSupplier } from '@/lib/bamida-po'
import { packSizeFor } from '@/lib/pack-size'
// Type-only, so the `server-only` guard in model-spec.ts never reaches this pure module
// or the unit tests that exercise it.
import type { ModelSpec } from '@/lib/model-spec'

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

/**
 * One printed line of the Specification table: what it is called and what it
 * says. Deliberately label-and-value rather than a fixed field list, because
 * the editor lets Juraj add a row the Hub has no column for, and the printer
 * must not need a code change to print it.
 */
export interface SupplierSpecRow {
  label: string
  value: string
}

export interface SupplierSpecProduct {
  model: string
  name: string
  quantity: number
  /** Barriers per pallet for this model, and the pallets it makes. */
  packSize: number
  pallets: number
  materials: SupplierSpecMaterial[]
  /**
   * The manufacturing specification for this model, or null when the Hub holds
   * none. Null prints NOTHING on the sheet since 22 Sep 2026 (Dean: "remove all
   * tags on the client facing PO"); the editor and the order page are where a
   * missing specification is said, and Martin or Juraj fill it in there.
   */
  spec: ModelSpec | null
  /**
   * The Specification table as rows, resolved from `spec` by
   * `specificationRows`. The printer reads THIS and never the ModelSpec, so an
   * edited document prints exactly what was saved, including rows that
   * correspond to no column.
   */
  specRows: SupplierSpecRow[]
  /** The bullets under Specific requirements: graphics notes then requirements. */
  bullets: string[]
  /**
   * Which document the standing values were read off, printed in the line that
   * says whether anybody has confirmed them. Held separately from `spec` so an
   * edited document keeps its provenance after the ModelSpec is out of the
   * picture.
   */
  sourceDocument: string | null
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

/**
 * 🔴 Kept only as the fallback wording when NO model specification is held at
 * all. It used to be the whole print specification, because none existed
 * anywhere in either database. It is no longer the answer for a model whose row
 * exists in model_spec.
 */

const round3 = (v: number) => Math.round(v * 1000) / 1000

/** Join the parts of a row that the templates keep in separate columns. */
const pair = (a: string | null, b: string | null) => [a, b].filter(Boolean).join(' / ') || null

/**
 * The Specification table for one model, in the order Bamida's own
 * OBJEDNAVKOVY LIST lists it.
 *
 * Only fields the Hub actually holds are emitted. A blank row on a factory
 * document reads as "no requirement", and that is not what an empty database
 * column means, so an absent value means an absent row.
 */
export function specificationRows(s: ModelSpec): SupplierSpecRow[] {
  const rows: SupplierSpecRow[] = []
  const add = (label: string, value: string | null) => {
    if (value) rows.push({ label, value })
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
  add('Graphics with logo', s.graphicsWithLogo)
  add('Pallet type', s.palletType)
  add('Frame (konštrukcia)', s.construction)
  add('Pallet height', s.maxPalletHeight)
  add('Pack (balenie)', s.packConfig)
  add('Include (pribaliť)', s.includeWithOrder)
  // 🔴 `notes` IS NEVER PRINTED. It is our working note about the row, to us, and it went onto a
  // client-facing factory order until Dean caught it on 17 Sep 2026. The H9 note read "Read from a
  // single UK order dated 06.08.2026 because H9 has no template. Confirm with Juraj that these are
  // the standing H9 values rather than that order's." That is an instruction to our own office
  // about our own uncertainty, and the factory has no business reading it. Anything the supplier
  // must act on is a specification row with a real label; anything else stays in the database.
  return rows
}

/** Graphics notes first, then the standing requirements, as the templates read. */
export function specificationBullets(s: ModelSpec): string[] {
  return [...s.graphicsNotes, ...s.specificRequirements].map((b) => b.trim()).filter(Boolean)
}

export function buildSupplierSpec(
  po: SroPoBom,
  isoDate: string,
  supplier: BamidaSupplier = DEFAULT_SUPPLIER,
  specNumber: string = '',
  destination: string | null = null,
  /**
   * Model code to specification. Defaults to empty so every existing caller and
   * every test keeps working and simply gets the old, specification-free
   * document rather than a crash.
   */
  specs: ReadonlyMap<string, ModelSpec> = new Map(),
): SupplierSpec {
  const products: SupplierSpecProduct[] = []
  let pallets = 0

  for (const line of po.lines) {
    if (!line.model_code) continue
    const model = specs.get(line.model_code) ?? null
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
      spec: model,
      sourceDocument: model?.sourceDocument ?? null,
      specRows: model ? specificationRows(model) : [],
      bullets: model ? specificationBullets(model) : [],
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
