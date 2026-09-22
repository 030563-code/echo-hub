/**
 * From an order line's SKU to the identities the other tables are keyed on: the
 * manufacturing model (bom_weekly_snapshot.model_code) and the internal SKU
 * (product_code_master.internal_sku).
 *
 * Both exist because a product has a different code in every region. France
 * orders EBH9X, Baltimore orders EBH9XNA, and both are product_code_master's
 * EBH9X, which is the key the bills of materials and the supplied-materials
 * recipe reach through. Normalise to the internal SKU and every region finds
 * the same recipe; key on the regional SKU and only North America ever does.
 *
 * The model half: bom_weekly_snapshot.model_code (H9, H10Japan, CSCompact).
 *
 * Two tables know it. po_product_catalog maps the North American SKUs
 * (EBH9NA) and the s.r.o. Japan ones; product_code_master maps the internal
 * SKUs (EBH9), which is what France, the UK and Group order under since
 * 22 Sep 2026, when the raise page started listing product_depot_mapping. A
 * line that neither knows has no model, and the caller says so rather than
 * exploding it to nothing in silence.
 *
 * Pure. Callers hand in the two maps they read.
 */

export type ModelBySku = ReadonlyMap<string, string | null>

/** The catalogue's answer first, then the code master's, then null. */
export function modelForSku(sku: string, catalogue: ModelBySku, master: ModelBySku): string | null {
  const key = String(sku ?? '').trim()
  if (!key) return null
  const fromCatalogue = catalogue.get(key)
  if (fromCatalogue) return fromCatalogue
  return master.get(key) ?? null
}

/** Build both maps from the two selects every caller runs. */
export function modelMaps(
  catalogueRows: readonly { sku: string; bom_model_code: string | null }[],
  masterRows: readonly { internal_sku: string; bom_model_code: string | null }[],
): { catalogue: ModelBySku; master: ModelBySku } {
  return {
    catalogue: new Map(catalogueRows.map((r) => [String(r.sku).trim(), r.bom_model_code])),
    master: new Map(masterRows.map((r) => [String(r.internal_sku).trim(), r.bom_model_code])),
  }
}

// ---------------------------------------------------------------------------
// The internal SKU: what every region's code has in common
// ---------------------------------------------------------------------------

export interface InternalSkuMaps {
  /** A regional SKU to its internal SKU (po_product_catalog). */
  bySku: ReadonlyMap<string, string>
  /** Every internal SKU product_code_master knows, so one can be recognised on sight. */
  known: ReadonlySet<string>
}

export function internalSkuMaps(
  catalogueRows: readonly { sku: string; internal_sku: string | null }[],
  masterRows: readonly { internal_sku: string }[],
): InternalSkuMaps {
  const bySku = new Map<string, string>()
  for (const r of catalogueRows) {
    const sku = String(r.sku ?? '').trim()
    const internal = String(r.internal_sku ?? '').trim()
    if (sku && internal) bySku.set(sku, internal)
  }
  return {
    bySku,
    known: new Set(masterRows.map((r) => String(r.internal_sku ?? '').trim()).filter(Boolean)),
  }
}

/**
 * The internal SKU behind a line's SKU, or null when nothing places it.
 *
 * A regional SKU resolves through the catalogue; an internal SKU is already
 * one and answers itself, which is how France, the UK and Group resolve since
 * they order under the internal codes. An s.r.o. SKU (EBH9SK) is in neither
 * table, so it answers null rather than being guessed at.
 */
export function internalSkuFor(sku: string, maps: InternalSkuMaps): string | null {
  const key = String(sku ?? '').trim()
  if (!key) return null
  return maps.bySku.get(key) ?? (maps.known.has(key) ? key : null)
}
