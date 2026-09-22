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
 * 🔴 THE DATA DECIDES, NOT AN ALLOWLIST. Until 22 Sep 2026 one line here read
 * `MANUFACTURABLE_SKUS = new Set(['EBH9NA'])`, from Dean's decision of 8 Sep
 * when the H9 delivery note was the only one transcribed. Eighteen products now
 * have a bill of materials off a delivery note and every one of them has all of
 * its gating components joined to a live Bamida stock card, so the allowlist was
 * refusing figures it had the data for. Dean, 22 Sep: "do not worry about labels
 * please they know this Bamida provided this to us." A product is computable
 * when it has a bill of materials with components; nothing else gates it.
 *
 * 🔴 EVERY REGION REACHES THE SAME RECIPE. The bill of materials and the
 * supplied-materials map are keyed on North American SKUs, and since 22 Sep
 * France, the UK and Group raise orders under the INTERNAL SKUs
 * (EBH9X, not EBH9XNA). Both sides are normalised to the internal SKU here, so a
 * French H9X and a Baltimore H9X find one recipe. An s.r.o. SKU (EBH9SK) is in
 * neither table and resolves to nothing, which the screen shows as it is.
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
import { internalSkuFor, internalSkuMaps } from '@/lib/sku-model'

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

  // 🔴 The whole map, not `.in('hub_sku', skus)`. Its keys are North American
  // SKUs and the order's may be internal ones, so the join happens after both
  // sides are normalised, not in the query. Three small tables.
  const [{ data: mapRows }, { data: catalogueRows }, { data: masterRows }] = await Promise.all([
    admin.from('mrp_bom_sku_map').select('hub_sku, fg_code'),
    admin.from('po_product_catalog').select('sku, internal_sku'),
    admin.from('product_code_master').select('internal_sku'),
  ])
  const identity = internalSkuMaps(
    (catalogueRows ?? []) as { sku: string; internal_sku: string | null }[],
    (masterRows ?? []) as { internal_sku: string }[],
  )

  /** fg_code by INTERNAL sku, so every region's code lands on one recipe. */
  const fgByInternal = new Map<string, string>()
  for (const r of mapRows ?? []) {
    const internal = internalSkuFor(String(r.hub_sku), identity)
    if (internal && !fgByInternal.has(internal)) fgByInternal.set(internal, String(r.fg_code))
  }
  const mapped = new Map<string, { fgCode: string }>()
  for (const sku of skus) {
    const internal = internalSkuFor(sku, identity)
    const fg = internal ? fgByInternal.get(internal) : undefined
    if (fg) mapped.set(sku, { fgCode: fg })
  }
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
      // Normalised to the internal SKU below, so this is fetched whole too.
      admin.from('mrp_bom_map').select('finished_sku, component_code, component_desc, qty_per'),
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
  // Both sides keyed on the internal SKU: a French EBH9X and a Baltimore
  // EBH9XNA are one product and draw on one recipe.
  const supplied = ((suppliedRows ?? []) as SuppliedBomRow[]).map((r) => ({
    ...r,
    finished_sku: internalSkuFor(String(r.finished_sku), identity) ?? String(r.finished_sku),
  }))
  const sroStockByCode = new Map<string, number>(
    (sroMaterialRows ?? []).map((m) => [String(m.component_code), Number(m.quantity)]),
  )
  const suppliedFor = (sku: string, quantity: number) => {
    const internal = internalSkuFor(sku, identity) ?? sku
    return supplied.some((r) => r.finished_sku === internal)
      ? suppliedShortagesFor(supplied, sroStockByCode, internal, quantity)
      : null
  }

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
    supplied: null,
  }
}
