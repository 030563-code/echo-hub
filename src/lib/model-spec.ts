import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * The manufacturing specification for one barrier model, as Bamida's own
 * OBJEDNÁVKOVÝ LIST states it.
 *
 * Juraj asked for far more detail on the manufacturing order than the Hub was
 * printing. Until this existed the -1 document carried the bill of materials, a
 * pallet count and the single word "Standard" for printing, because no colour,
 * material or packing field existed anywhere in either database.
 *
 * 🔴 `confirmed` is false until Juraj signs a row off, and the document says so
 * on its face. A spec read out of one historic order is evidence, not a
 * standing instruction: the Japanese H10 row carries Japanese graphics and a
 * hook and lanyard pack that belong to that order rather than to the model.
 */
export interface ModelSpec {
  modelCode: string
  productLabel: string
  dimensions: string | null

  graphicsPrint: string | null
  graphicsNotes: string[]
  graphicsWithLogo: string | null

  pvcType: string | null
  pvcRal: string | null
  pvcColour: string | null

  meshType: string | null
  meshColour: string | null

  goretexType: string | null
  goretexColour: string | null

  infillType: string | null
  infillDimensions: string | null

  threadType: string | null
  threadColour: string | null

  reflectiveType: string | null
  reflectiveColour: string | null

  rings: string | null
  buckles: string | null

  palletType: string | null
  construction: string | null
  maxPalletHeight: string | null

  specificRequirements: string[]
  packConfig: string | null
  includeWithOrder: string | null

  sourceDocument: string
  confirmed: boolean
  notes: string | null
}

const COLUMNS =
  'model_code, product_label, dimensions, graphics_print, graphics_notes, graphics_with_logo, ' +
  'pvc_type, pvc_ral, pvc_colour, mesh_type, mesh_colour, goretex_type, goretex_colour, ' +
  'infill_type, infill_dimensions, thread_type, thread_colour, reflective_type, reflective_colour, ' +
  'rings, buckles, pallet_type, construction, max_pallet_height, specific_requirements, ' +
  'pack_config, include_with_order, source_document, confirmed, notes'

type Row = Record<string, unknown>

const str = (v: unknown): string | null => {
  const s = typeof v === 'string' ? v.trim() : ''
  return s === '' ? null : s
}
const list = (v: unknown): string[] =>
  Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : []

function toSpec(r: Row): ModelSpec {
  return {
    modelCode: String(r.model_code),
    productLabel: str(r.product_label) ?? String(r.model_code),
    dimensions: str(r.dimensions),
    graphicsPrint: str(r.graphics_print),
    graphicsNotes: list(r.graphics_notes),
    graphicsWithLogo: str(r.graphics_with_logo),
    pvcType: str(r.pvc_type),
    pvcRal: str(r.pvc_ral),
    pvcColour: str(r.pvc_colour),
    meshType: str(r.mesh_type),
    meshColour: str(r.mesh_colour),
    goretexType: str(r.goretex_type),
    goretexColour: str(r.goretex_colour),
    infillType: str(r.infill_type),
    infillDimensions: str(r.infill_dimensions),
    threadType: str(r.thread_type),
    threadColour: str(r.thread_colour),
    reflectiveType: str(r.reflective_type),
    reflectiveColour: str(r.reflective_colour),
    rings: str(r.rings),
    buckles: str(r.buckles),
    palletType: str(r.pallet_type),
    construction: str(r.construction),
    maxPalletHeight: str(r.max_pallet_height),
    specificRequirements: list(r.specific_requirements),
    packConfig: str(r.pack_config),
    includeWithOrder: str(r.include_with_order),
    sourceDocument: String(r.source_document ?? 'unknown'),
    confirmed: r.confirmed === true,
    notes: str(r.notes),
  }
}

/**
 * Every model specification, keyed on model code.
 *
 * Returns an EMPTY map rather than throwing when the read fails. A missing
 * specification must degrade the document to what it printed before, not stop
 * the factory being sent an order at all: the bill of materials and the pallet
 * count are still correct and still useful on their own.
 */
export async function loadModelSpecs(client: SupabaseClient): Promise<Map<string, ModelSpec>> {
  const { data, error } = await client.from('model_spec').select(COLUMNS)
  if (error || !data) return new Map()
  return new Map((data as unknown as Row[]).map((r) => [String(r.model_code), toSpec(r)]))
}
