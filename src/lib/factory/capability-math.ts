/**
 * What the factory can build against what we will need, as pure arithmetic.
 *
 * Bamida's CEO, 18 Sep 2026: "Minimum stock levels. It is crucial for the system
 * to be able to alert the warehouse when the stock of any material runs low.
 * Only you can configure this. We do not know the volume of orders or their
 * priorities."
 *
 * 🔴 NOTHING OF OURS CROSSES THIS BOUNDARY. Dean, 18 Sep 2026: show them a
 * breakdown "based on THEIR material and not reveal some of our internal
 * information on our own material and quotes in the system and those
 * calculations". So the only number of ours on the whole factory side is the
 * single quantity we want built. Where it came from (our depot stock, what is
 * in transit, what is on order, firm orders, the weighted quote pipeline) is
 * not read, not passed, and not rendered. An earlier cut of this printed all
 * five under every row, in Slovak, on their screen.
 *
 * The ceiling is computed here rather than read from the engine's nightly row.
 * Same function, same inputs, but it covers every product on a bill of
 * materials instead of only the six with a Hub SKU mapped, and it moves when
 * their feed moves rather than when the engine last ran.
 */

import { materialsCeiling, requiredFor, type BomComponentRow } from '@/lib/mrp/materials'

/** A product Bamida builds, as their own delivery note names it. */
export interface FactoryBomProduct {
  fg_code: string
  fg_label: string | null
  pallet_size: number | null
}

/**
 * The engine's nightly row, cut to the one column that says what we want built.
 * The flow position behind it stays on our side of the wall.
 */
export interface CapabilityStatusRow {
  sku: string
  run_date: string
  action_qty: number | null
  flags: string[] | null
}

export interface SkuMapRow {
  hub_sku: string
  fg_code: string
  confirmed: boolean | null
}

export interface FactoryProductCapability {
  /** Bamida's own finished-good code. Our SKU never leaves the building. */
  fgCode: string
  productName: string
  palletSize: number | null
  /** Units they could build now. Null when the engine could not work it out. */
  maxBuildable: number | null
  bindingCode: string | null
  bindingDesc: string | null
  /** Units we need built. Null when we hold no forecast for this product. */
  requirement: number | null
  /** True when the requirement exceeds what the materials allow. */
  short: boolean
  /** True while the bill of materials or its mapping is unconfirmed. Shown, never hidden. */
  provisional: boolean
}

const num = (v: number | null | undefined) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

/** "Výroba Echo Barrier H9X (1335 x 2550 mm)" is their name for it, minus the verb. */
export function productLabel(p: FactoryBomProduct): string {
  const label = (p.fg_label ?? '').trim().replace(/^v[ýy]roba\s+/i, '')
  return label || p.fg_code
}

/** Material lines only: operations are labour and intermediates are made in-house. */
function materialLines(components: readonly BomComponentRow[], fgCode: string): BomComponentRow[] {
  return components.filter((c) => c.fg_code === fgCode && c.line_type === 'material')
}

/**
 * One row per product that has a bill of materials, worst first: short
 * products, then the largest requirement, then by name so the order is stable.
 *
 * Every product is listed, mapped to a Hub SKU or not. A product with no
 * mapping still has a ceiling, because a ceiling needs only their stock and
 * their parts list; it has no requirement, because that is ours.
 */
export function productCapabilities(input: {
  products: readonly FactoryBomProduct[]
  components: readonly BomComponentRow[]
  stockByCode: ReadonlyMap<string, number>
  skuMap?: readonly SkuMapRow[]
  status?: readonly CapabilityStatusRow[]
  /** Hub SKU → the product name we print everywhere else. */
  names?: ReadonlyMap<string, string>
}): FactoryProductCapability[] {
  const { products, components, stockByCode } = input
  const skuMap = input.skuMap ?? []
  const status = input.status ?? []
  const names = input.names ?? new Map<string, string>()

  const statusBySku = new Map(status.map((s) => [s.sku, s]))

  // Several Hub SKUs can share one finished good. They draw on the same
  // materials, so their requirements add up rather than compete.
  const demandByFg = new Map<string, { qty: number; known: boolean; provisional: boolean; name: string | null }>()
  for (const m of skuMap) {
    const d = demandByFg.get(m.fg_code) ?? { qty: 0, known: false, provisional: false, name: null }
    const s = statusBySku.get(m.hub_sku)
    if (s) {
      d.known = true
      d.qty += Math.max(0, Math.round(num(s.action_qty)))
    }
    if (m.confirmed !== true || (s?.flags ?? []).includes('materials_map_provisional')) d.provisional = true
    d.name = d.name ?? names.get(m.hub_sku) ?? null
    demandByFg.set(m.fg_code, d)
  }

  const out: FactoryProductCapability[] = []
  for (const p of products) {
    const lines = materialLines(components, p.fg_code)
    if (lines.length === 0) continue
    const ceiling = materialsCeiling({ fg_code: p.fg_code, pallet_size: p.pallet_size }, lines, stockByCode)
    const d = demandByFg.get(p.fg_code)
    const requirement = d?.known ? d.qty : null
    out.push({
      fgCode: p.fg_code,
      productName: d?.name ?? productLabel(p),
      palletSize: p.pallet_size,
      maxBuildable: ceiling.maxBuildable,
      bindingCode: ceiling.bindingComponent,
      bindingDesc: ceiling.bindingDesc,
      requirement,
      short: requirement !== null && requirement > 0 && ceiling.maxBuildable !== null && ceiling.maxBuildable < requirement,
      // No mapping is not a confirmed mapping, and every bill of materials we
      // hold was read off a delivery note rather than an engineering drawing.
      provisional: d?.provisional ?? true,
    })
  }

  return out.sort(
    (a, b) =>
      Number(b.short) - Number(a.short) ||
      (b.requirement ?? -1) - (a.requirement ?? -1) ||
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
  components: readonly BomComponentRow[],
  stockByCode: ReadonlyMap<string, number>,
): Map<string, MaterialNeed> {
  const needs = new Map<string, MaterialNeed>()
  for (const p of products) {
    if (!p.requirement) continue
    const gating = materialLines(components, p.fgCode).filter((c) => c.is_gating)
    for (const [code, qty] of requiredFor(gating, p.palletSize, p.requirement)) {
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

/** One material line of a product, with the arithmetic shown rather than asserted. */
export interface MaterialDrawRow {
  code: string
  description: string | null
  perUnit: number
  perPallet: number
  /** Total draw for `qty` units: perUnit × qty + perPallet × ceil(qty / palletSize). */
  needed: number
  /** Their stock, or null when their feed carries no card for this code. */
  have: number | null
  short: number
  /** The material that caps the ceiling. */
  binding: boolean
  /** False for the lines their feed does not report, which cannot constrain anything. */
  gating: boolean
}

/**
 * Every material line of one product against their shelf, for a build of `qty`.
 *
 * This is the breakdown the factory sees. It contains their parts list, their
 * stock and one quantity of ours, and it is written so a person can check the
 * arithmetic by hand rather than take the ceiling on trust.
 */
export function productDraw(
  product: FactoryProductCapability,
  components: readonly BomComponentRow[],
  stockByCode: ReadonlyMap<string, number>,
  qty: number,
): MaterialDrawRow[] {
  const lines = materialLines(components, product.fgCode)
  const pallets = product.palletSize && product.palletSize > 0 ? Math.ceil(qty / product.palletSize) : 0
  const byCode = new Map<string, MaterialDrawRow>()

  for (const c of lines) {
    const row = byCode.get(c.component_code) ?? {
      code: c.component_code,
      description: c.component_desc,
      perUnit: 0,
      perPallet: 0,
      needed: 0,
      have: stockByCode.has(c.component_code) ? (stockByCode.get(c.component_code) ?? 0) : null,
      short: 0,
      binding: c.component_code === product.bindingCode,
      gating: false,
    }
    if (c.basis === 'per_unit') {
      row.perUnit += c.qty
      row.needed += c.qty * qty
    } else {
      row.perPallet += c.qty
      // A pallet row with no pallet size cannot be costed, so it is left at
      // zero rather than guessed. materialsCeiling skips it for the same reason.
      row.needed += c.qty * pallets
    }
    row.gating = row.gating || c.is_gating
    byCode.set(c.component_code, row)
  }

  const rows = [...byCode.values()]
  for (const r of rows) r.short = r.have === null ? 0 : Math.max(0, r.needed - r.have)
  return rows.sort((a, b) => b.short - a.short || Number(b.binding) - Number(a.binding) || a.code.localeCompare(b.code))
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
    .map((p) => `${p.fgCode}:${p.requirement}>${p.maxBuildable}`)
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
