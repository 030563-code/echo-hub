/**
 * From an order line's SKU to the manufacturing model the bill of materials is
 * keyed on (bom_weekly_snapshot.model_code: H9, H10Japan, CSCompact).
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
