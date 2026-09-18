/**
 * What the factory can build against what we will need, as pure arithmetic.
 *
 * Bamida's CEO, 18 Sep 2026: "Minimum stock levels. It is crucial for the system
 * to be able to alert the warehouse when the stock of any material runs low.
 * Only you can configure this. We do not know the volume of orders or their
 * priorities."
 *
 * Nothing here is new maths. The ceiling per product is what the MRP engine
 * already persists every night (max_buildable and the material that caps it),
 * and the requirement is the engine's action quantity, which already nets
 * firm demand and the weighted pipeline against stock on hand, in transit and
 * on order. This module only lines the two up per product, then turns the
 * requirement back into material quantities so a shortfall can be named per
 * material rather than per barrier. `requiredFor` from the MRP materials module
 * does that translation and already knows that packing consumables are drawn
 * per pallet rather than per unit.
 *
 * Pure on purpose: the page loader and the alert route both call it, and the
 * tests pin the shape without a database.
 */

import { requiredFor, type BomComponentRow, type BomProductRow } from '@/lib/mrp/materials'

/** One product's row from the latest engine run, only the fields this needs. */
export interface CapabilityStatusRow {
  sku: string
  run_date: string
  max_buildable: number | null
  materials_binding_code: string | null
  materials_binding_desc: string | null
  action_qty: number | null
  firm_demand: number | null
  qualified_spikes: number | null
  on_hand: number | null
  in_transit: number | null
  on_order: number | null
  flags: string[] | null
}

export interface SkuMapRow {
  hub_sku: string
  fg_code: string
  confirmed: boolean | null
}

export interface FactoryProductCapability {
  sku: string
  productName: string
  runDate: string
  /** Units they could build now. Null when the engine could not work it out. */
  maxBuildable: number | null
  bindingCode: string | null
  bindingDesc: string | null
  /** Units we need built, from the engine. Never negative. */
  requirement: number
  firmDemand: number
  weightedPipeline: number
  onHand: number
  inTransit: number
  onOrder: number
  /** True when the requirement exceeds what the materials allow. */
  short: boolean
  /** True while nobody has confirmed the SKU to finished-good mapping. Shown, never hidden. */
  provisional: boolean
}

const num = (v: number | null | undefined) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

/**
 * One row per product that has a bill of materials, worst first: short
 * products, then the largest requirement, then by name so the order is stable.
 */
export function productCapabilities(
  rows: readonly CapabilityStatusRow[],
  skuMap: readonly SkuMapRow[],
  names: ReadonlyMap<string, string>,
): FactoryProductCapability[] {
  const mapped = new Map(skuMap.map((m) => [m.hub_sku, m]))
  const out: FactoryProductCapability[] = []
  for (const r of rows) {
    const map = mapped.get(r.sku)
    if (!map) continue
    const requirement = Math.max(0, Math.round(num(r.action_qty)))
    const maxBuildable =
      typeof r.max_buildable === 'number' && Number.isFinite(r.max_buildable) ? r.max_buildable : null
    out.push({
      sku: r.sku,
      productName: names.get(r.sku) ?? r.sku,
      runDate: r.run_date,
      maxBuildable,
      bindingCode: r.materials_binding_code,
      bindingDesc: r.materials_binding_desc,
      requirement,
      firmDemand: Math.round(num(r.firm_demand)),
      weightedPipeline: Math.round(num(r.qualified_spikes)),
      onHand: num(r.on_hand),
      inTransit: num(r.in_transit),
      onOrder: num(r.on_order),
      short: requirement > 0 && maxBuildable !== null && maxBuildable < requirement,
      provisional: map.confirmed !== true || (r.flags ?? []).includes('materials_map_provisional'),
    })
  }
  return out.sort(
    (a, b) =>
      Number(b.short) - Number(a.short) ||
      b.requirement - a.requirement ||
      a.productName.localeCompare(b.productName),
  )
}

export interface MaterialNeed {
  /** Total draw across every product's requirement, per-unit and per-pallet rows combined. */
  needed: number
  /** Physical stock on the shelf, or null when the feed has no card for it. */
  have: number | null
  /** needed minus have, never negative; zero when unknown. */
  short: number
  /** The products that draw on it, for the reader to see why. */
  products: string[]
}

/**
 * The requirement per product, exploded into material quantities and summed
 * per material. Only gating rows: those are the materials their feed reports,
 * and the ones the ceiling itself rests on.
 */
export function materialNeeds(
  products: readonly FactoryProductCapability[],
  skuMap: readonly SkuMapRow[],
  bomProducts: readonly BomProductRow[],
  components: readonly BomComponentRow[],
  stockByCode: ReadonlyMap<string, number>,
): Map<string, MaterialNeed> {
  const fgBySku = new Map(skuMap.map((m) => [m.hub_sku, m.fg_code]))
  const palletByFg = new Map(bomProducts.map((p) => [p.fg_code, p.pallet_size]))
  const componentsByFg = new Map<string, BomComponentRow[]>()
  for (const c of components) {
    if (!c.is_gating) continue
    const list = componentsByFg.get(c.fg_code) ?? []
    list.push(c)
    componentsByFg.set(c.fg_code, list)
  }

  const needs = new Map<string, MaterialNeed>()
  for (const p of products) {
    if (p.requirement <= 0) continue
    const fg = fgBySku.get(p.sku)
    if (!fg) continue
    const draw = requiredFor(componentsByFg.get(fg) ?? [], palletByFg.get(fg) ?? null, p.requirement)
    for (const [code, qty] of draw) {
      const have = stockByCode.has(code) ? (stockByCode.get(code) ?? 0) : null
      const existing = needs.get(code) ?? { needed: 0, have, short: 0, products: [] }
      existing.needed += qty
      existing.short = existing.have === null ? 0 : Math.max(0, existing.needed - existing.have)
      if (!existing.products.includes(p.productName)) existing.products.push(p.productName)
      needs.set(code, existing)
    }
  }
  return needs
}

/**
 * What an alert is about, as one canonical string. Two mornings with the same
 * short products and the same short materials produce the same string, so the
 * factory is told once; any change in the set or the amounts is a new alert.
 * The caller hashes it; keeping the plain text here makes the test readable.
 */
export function alertSignature(
  products: readonly FactoryProductCapability[],
  needs: ReadonlyMap<string, MaterialNeed>,
): string {
  const shortProducts = products
    .filter((p) => p.short)
    .map((p) => `${p.sku}:${p.requirement}>${p.maxBuildable}`)
    .sort()
  const shortMaterials = Array.from(needs.entries())
    .filter(([, n]) => n.short > 0)
    .map(([code, n]) => `${code}:${Math.ceil(n.short)}`)
    .sort()
  return `products=${shortProducts.join(',')};materials=${shortMaterials.join(',')}`
}

/** True when there is anything worth telling the factory about. */
export function anythingShort(
  products: readonly FactoryProductCapability[],
  needs: ReadonlyMap<string, MaterialNeed>,
): boolean {
  return products.some((p) => p.short) || Array.from(needs.values()).some((n) => n.short > 0)
}
