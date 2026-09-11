import 'server-only'

/**
 * What Bamida could actually build right now, for the lines on one order.
 *
 * The arithmetic is not here. It is in @/lib/mrp/materials, which the MRP
 * engine already uses and which handles the two things that make this hard: a
 * component drawn both per unit and per pallet from one stock pool, and a
 * component with no stock card, which is unknown rather than zero. This module
 * is only the data-loading half, shared by the screen that shows the figure and
 * by the email that has to say what is short.
 *
 * H9 ONLY, by Dean's decision on 8 Sep 2026. Its bill of materials was read off
 * delivery note DLE26060008 and all ten of its gating components join live
 * Bamida stock. H10's note is the welded-reflective-tape variant carrying a
 * Serge Ferrari mesh as well as the Mehler skin, so nobody can yet say whether
 * it is the base product. Showing a number for it would be inventing one.
 */

import { createAdminClient } from '@/lib/supabase/admin'
import {
  materialsCeiling,
  shortagesFor,
  type BomComponentRow,
  type BomProductRow,
  type MaterialShortage,
} from '@/lib/mrp/materials'
import {
  suppliedShortagesFor,
  type SuppliedBomRow,
  type SuppliedShortage,
} from '@/lib/mrp/supplied-materials'
import { SRO_WAREHOUSE } from '@/lib/stock/warehouses'

/** The Hub SKUs whose bill of materials is good enough to quote a figure from. */
export const MANUFACTURABLE_SKUS = new Set(['EBH9NA'])

export type LineCapability = {
  sku: string
  productName: string | null
  quantity: number
  /** False when this SKU has no usable bill of materials, so no figure is shown. */
  computable: boolean
  /** Units buildable now. Null when it could not be worked out. */
  maxBuildable: number | null
  /** The component that binds the ceiling: what to go and buy. */
  bindingCode: string | null
  bindingDescription: string | null
  /** Empty means the materials for THIS quantity are there. */
  shortages: MaterialShortage[]
  /** Gating components with no stock card. Excluded from the answer, never hidden. */
  unjoined: string[]
  /** True while the SKU to finished-good mapping is still nobody's confirmed word. */
  mappingProvisional: boolean
  /**
   * The s.r.o.-supplied materials (PC350FR, infill, Datatag) against the
   * s.r.o.-owned stock, from the unverified mrp_bom_map recipe. INFORMS ONLY:
   * it never feeds anyShort or blocks a button. Null when the SKU has no rows
   * in that recipe.
   */
  supplied: { shortages: SuppliedShortage[]; unjoined: string[] } | null
}

export type OrderCapability = {
  lines: LineCapability[]
  /** True when any line is short. Chooses which email Bamida receive. */
  anyShort: boolean
  /** True when no line could be evaluated at all. */
  nothingComputable: boolean
}

export type CapabilityLineInput = {
  sku: string | null
  product_name?: string | null
  quantity: number | null
}

/**
 * One round trip for the whole order. Reads physical `quantity`, never
 * `available_quantity`: Bamida's available figure is net of reservations they
 * never drain and runs deeply negative, which would make everything
 * permanently unbuildable.
 */
export async function assessOrderCapability(
  lines: readonly CapabilityLineInput[],
): Promise<OrderCapability> {
  const skus = Array.from(
    new Set(lines.map((l) => String(l.sku ?? '').trim()).filter((s) => s !== '')),
  )
  if (skus.length === 0) return { lines: [], anyShort: false, nothingComputable: true }

  const admin = createAdminClient()

  const { data: mapRows } = await admin
    .from('mrp_bom_sku_map')
    .select('hub_sku, fg_code, confirmed')
    .in('hub_sku', skus)

  const mapped = new Map(
    (mapRows ?? [])
      .filter((r) => MANUFACTURABLE_SKUS.has(String(r.hub_sku)))
      .map((r) => [String(r.hub_sku), { fgCode: String(r.fg_code), confirmed: r.confirmed === true }]),
  )
  const fgCodes = Array.from(new Set(Array.from(mapped.values()).map((m) => m.fgCode)))

  if (fgCodes.length === 0) {
    return {
      lines: lines.map((l) => blankLine(l)),
      anyShort: false,
      nothingComputable: true,
    }
  }

  const [{ data: productRows }, { data: componentRows }, { data: stockRows }, { data: suppliedRows }, { data: sroMaterialRows }] =
    await Promise.all([
      admin.from('mrp_bom_product').select('fg_code, pallet_size').in('fg_code', fgCodes),
      admin
        .from('mrp_bom_component')
        .select('fg_code, component_code, component_desc, qty, basis, line_type, is_gating, source_kind')
        .in('fg_code', fgCodes),
      admin.from('bamida_material_stock').select('ns_number, quantity').eq('is_active', true),
      // The s.r.o.-supplied recipe and the s.r.o.-owned stock behind it. A
      // different code namespace from ns_number, so a second map, not a merge.
      admin.from('mrp_bom_map').select('finished_sku, component_code, component_desc, qty_per').in('finished_sku', skus),
      admin.from('material_stock_levels').select('component_code, quantity').eq('warehouse_code', SRO_WAREHOUSE),
    ])

  const productByFg = new Map<string, BomProductRow>(
    (productRows ?? []).map((p) => [String(p.fg_code), p as BomProductRow]),
  )
  const componentsByFg = new Map<string, BomComponentRow[]>()
  for (const row of (componentRows ?? []) as BomComponentRow[]) {
    const list = componentsByFg.get(row.fg_code)
    if (list) list.push(row)
    else componentsByFg.set(row.fg_code, [row])
  }
  const stockByCode = new Map<string, number>(
    (stockRows ?? []).map((s) => [String(s.ns_number), Number(s.quantity)]),
  )
  const supplied = (suppliedRows ?? []) as SuppliedBomRow[]
  const sroStockByCode = new Map<string, number>(
    (sroMaterialRows ?? []).map((m) => [String(m.component_code), Number(m.quantity)]),
  )
  const suppliedFor = (sku: string, quantity: number) =>
    supplied.some((r) => r.finished_sku === sku)
      ? suppliedShortagesFor(supplied, sroStockByCode, sku, quantity)
      : null

  const assessed = lines.map((line): LineCapability => {
    const sku = String(line.sku ?? '').trim()
    const map = mapped.get(sku)
    const product = map ? productByFg.get(map.fgCode) : undefined
    const components = map ? componentsByFg.get(map.fgCode) : undefined
    if (!map || !product || !components || components.length === 0) {
      return { ...blankLine(line), supplied: suppliedFor(sku, Number(line.quantity ?? 0)) }
    }

    const quantity = Number(line.quantity ?? 0)
    const ceiling = materialsCeiling(product, components, stockByCode)
    const short = shortagesFor(product, components, stockByCode, quantity)

    return {
      sku,
      productName: line.product_name ?? null,
      quantity,
      computable: true,
      maxBuildable: ceiling.maxBuildable,
      bindingCode: ceiling.bindingComponent,
      bindingDescription: ceiling.bindingDesc,
      shortages: short.shortages,
      unjoined: Array.from(new Set([...ceiling.unjoined, ...short.unjoined])),
      mappingProvisional: !map.confirmed,
      supplied: suppliedFor(sku, quantity),
    }
  })

  return {
    lines: assessed,
    anyShort: assessed.some((l) => l.shortages.length > 0),
    nothingComputable: assessed.every((l) => !l.computable),
  }
}

function blankLine(line: CapabilityLineInput): LineCapability {
  return {
    sku: String(line.sku ?? '').trim(),
    productName: line.product_name ?? null,
    quantity: Number(line.quantity ?? 0),
    computable: false,
    maxBuildable: null,
    bindingCode: null,
    bindingDescription: null,
    shortages: [],
    unjoined: [],
    mappingProvisional: false,
    supplied: null,
  }
}
