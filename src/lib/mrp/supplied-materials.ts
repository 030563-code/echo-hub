/**
 * The OTHER bill of materials: components Echo Barrier s.r.o. buys and hands to
 * Bamida (PC350FR membrane rolls, Senizol acoustic infill, foam, Datatag).
 *
 * It lives in mrp_bom_map and is disjoint from the Bamida consumption BOM in
 * mrp_bom_component: none of these appear on a Bamida delivery note, and
 * PC350 has no card in Bamida's stock feed, so the manufacturing gate in
 * @/lib/mrp/materials cannot see them at all. That gate could say "H9
 * buildable: 280" with no fabric in the building. This module answers the
 * other half: is there enough s.r.o.-owned material for THIS order.
 *
 * Two rules carried over from materials.ts:
 * - A component with no stock card is UNKNOWN, reported in `unjoined`, never
 *   counted as zero. Zero would make everything permanently short.
 * - All 194 rows of mrp_bom_map are unverified (a spreadsheet, not a document),
 *   so the answer INFORMS and never BLOCKS a decision. The caller renders it as
 *   a guide; nothing here decides anything.
 *
 * Pure. No imports.
 */

export interface SuppliedBomRow {
  finished_sku: string
  component_code: string
  component_desc: string | null
  /** Quantity of the component per ONE finished unit, in the component's unit. */
  qty_per: number
}

export interface SuppliedShortage {
  code: string
  description: string | null
  need: number
  have: number
  short: number
}

/**
 * Rows in mrp_bom_map that are charges, not things on a shelf: a slitting fee
 * and three transport lines. They carry a qty_per like everything else and
 * would otherwise read as a material with no stock card.
 */
export const SUPPLIED_CHARGE_CODES: ReadonlySet<string> = new Set([
  'GRP-SLTF',
  'ACI-TRNS',
  'ACI-TRNS-OP',
  'PC350FR-TRNS',
])

const round3 = (n: number) => Math.round(n * 1000) / 1000

/**
 * What one SKU at one quantity needs, per component code. Linear, unlike the
 * Bamida BOM: this recipe has no per-pallet tier. Charge codes are dropped.
 */
export function suppliedRequirement(
  rows: readonly SuppliedBomRow[],
  sku: string,
  qty: number,
): Map<string, number> {
  const need = new Map<string, number>()
  if (!(qty > 0)) return need
  for (const row of rows) {
    if (row.finished_sku !== sku) continue
    if (SUPPLIED_CHARGE_CODES.has(row.component_code)) continue
    const per = Number(row.qty_per)
    if (!(per > 0)) continue
    need.set(row.component_code, round3((need.get(row.component_code) ?? 0) + per * qty))
  }
  return need
}

/**
 * Shortages for one SKU at one quantity against s.r.o.-owned stock.
 *
 * `stockByCode` is component_code to quantity on hand. A code absent from it
 * goes to `unjoined`; the shortage list only names components we can actually
 * see. Sorted worst first, so the top line is what to go and buy.
 */
export function suppliedShortagesFor(
  rows: readonly SuppliedBomRow[],
  stockByCode: ReadonlyMap<string, number>,
  sku: string,
  qty: number,
): { shortages: SuppliedShortage[]; unjoined: string[] } {
  const need = suppliedRequirement(rows, sku, qty)
  const descByCode = new Map<string, string | null>()
  for (const row of rows) {
    if (!descByCode.has(row.component_code)) descByCode.set(row.component_code, row.component_desc)
  }

  const shortages: SuppliedShortage[] = []
  const unjoined: string[] = []
  for (const [code, required] of need) {
    if (!stockByCode.has(code)) {
      unjoined.push(code)
      continue
    }
    // Clamp at zero as a backstop: a level can go negative between counts once
    // consumption is estimated, and a negative "have" would inflate the short.
    const have = Math.max(0, Number(stockByCode.get(code) ?? 0))
    if (have >= required) continue
    shortages.push({
      code,
      description: descByCode.get(code) ?? null,
      need: required,
      have: round3(have),
      short: round3(required - have),
    })
  }
  shortages.sort((a, b) => b.short - a.short || a.code.localeCompare(b.code))
  unjoined.sort()
  return { shortages, unjoined }
}
