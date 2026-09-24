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
 * The model half: a product model (H9, H10Japan, CSCompact).
 *
 * Two tables know it. po_product_catalog maps the North American SKUs
 * (EBH9NA) and the s.r.o. Japan ones; product_code_master maps the internal
 * SKUs (EBH9), which is what France, the UK and Group order under since
 * 22 Sep 2026, when the raise page started listing product_depot_mapping. A
 * line that neither knows has no model, and the caller says so rather than
 * exploding it to nothing in silence.
 *
 * For most products that model is also the bill of materials' key
 * (bom_weekly_snapshot.model_code), but not for all: product_code_master spells
 * a product the way the demand history does, because the demand feed joins on
 * it, so it says H9X and dB-RT where the manufacturing sheet says H9X 2.1W and
 * NDT. lineModels() below adds the model somebody chose under BOM
 * (bom_product_model) for exactly those.
 *
 * Pure. Callers hand in the maps they read.
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
// The manufacturing model: what a line is costed as
// ---------------------------------------------------------------------------

export interface LineModels {
  /**
   * The product model, what the specification and the packing list match a
   * line on. Saved -1 documents carry these names, so they stay as they were.
   */
  model: string | null
  /** The model it is costed as: the bill of materials row and the Bamida prices. */
  bomModel: string | null
}

/**
 * Both models for one line. The choice made under BOM wins for the costing and
 * leaves the product model alone, except where the product tables give none,
 * when the choice is the only model there is.
 */
export function lineModels(sku: string, catalogue: ModelBySku, master: ModelBySku, chosen: ModelBySku): LineModels {
  const model = modelForSku(sku, catalogue, master)
  const key = String(sku ?? '').trim()
  const picked = (key && chosen.get(key)) || null
  return { model: model ?? picked, bomModel: picked ?? model }
}

/** The bom_product_model rows as a map. */
export function chosenModels(rows: readonly { sku: string; model_code: string }[]): ModelBySku {
  return new Map(rows.map((r) => [String(r.sku).trim(), String(r.model_code).trim()]))
}

/** One product code on the BOM page's Product codes tab. */
export interface ProductModelRow {
  sku: string
  name: string | null
  /** Who orders under the code, in words: which table it comes from. */
  orderedBy: string
  /** What the product tables say. */
  listModel: string | null
  /** What somebody chose under BOM, when anybody has. */
  chosenModel: string | null
  /** What it is costed as. */
  model: string | null
  /** Whether the bill of materials has a row for that model. */
  hasBom: boolean
  chosenBy: string | null
  chosenAt: string | null
}

/** Families with no bill of materials of their own: bungies, hooks, logos, delivery lines. */
const NOT_MANUFACTURED = new Set(['accessories', 'acc', 'delinfo', 'custom'])

const ORDERED_BY: Record<string, string> = { NA: 'North America', SRO: 's.r.o. (Japan)' }

/**
 * Every product code the bill of materials could be asked about, with the model
 * it is costed as. A code with no model and an accessory family is left out,
 * because it never had a bill of materials to find. The ones that need looking
 * at, a model the bill of materials has no row for, come first.
 */
export function productModelRows(input: {
  catalogue: readonly { sku: string; product_name: string | null; bom_model_code: string | null; region: string | null; product_family: string | null; active: boolean | null }[]
  master: readonly { internal_sku: string; product_name: string | null; bom_model_code: string | null; product_family: string | null; is_active: boolean | null }[]
  chosen: readonly { sku: string; model_code: string; updated_by_label: string | null; updated_at: string }[]
  bomModels: ReadonlySet<string>
}): ProductModelRow[] {
  const chosen = new Map(input.chosen.map((c) => [String(c.sku).trim(), c]))
  const listed = [
    ...input.catalogue
      .filter((c) => c.active !== false)
      .map((c) => ({ sku: c.sku, name: c.product_name, model: c.bom_model_code, family: c.product_family, orderedBy: ORDERED_BY[c.region ?? ''] ?? (c.region || 'Catalogue') })),
    ...input.master
      .filter((m) => m.is_active !== false)
      .map((m) => ({ sku: m.internal_sku, name: m.product_name, model: m.bom_model_code, family: m.product_family, orderedBy: 'Group, UK and France' })),
  ]

  const seen = new Set<string>()
  const rows: ProductModelRow[] = []
  for (const l of listed) {
    const sku = String(l.sku ?? '').trim()
    if (!sku || seen.has(sku)) continue
    seen.add(sku)
    const pick = chosen.get(sku) ?? null
    const listModel = l.model?.trim() || null
    if (!listModel && !pick && NOT_MANUFACTURED.has(String(l.family ?? '').trim().toLowerCase())) continue
    const model = pick?.model_code ?? listModel
    rows.push({
      sku,
      name: l.name,
      orderedBy: l.orderedBy,
      listModel,
      chosenModel: pick?.model_code ?? null,
      model,
      hasBom: model != null && input.bomModels.has(model),
      chosenBy: pick?.updated_by_label ?? null,
      chosenAt: pick?.updated_at ?? null,
    })
  }
  return rows.sort((a, b) => Number(a.hasBom) - Number(b.hasBom) || a.sku.localeCompare(b.sku))
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
