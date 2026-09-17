import 'server-only'

/**
 * Reading and writing the -1 specification for one order. The document itself lives in
 * po-spec-draft.ts, which is pure; this is only the trip to the database.
 *
 * Three states, and the printed document says which one it is in on its face:
 *
 *   NOTHING SAVED    generated from the bill of materials and model_spec every time it is
 *                    printed, and prints SPECIFICATION NOT YET CONFIRMED.
 *   SAVED            prints what was saved, word for word. Still unconfirmed.
 *   CONFIRMED        prints who signed it and when, instead of the red warning.
 */

import { createAdminClient } from '@/lib/supabase/admin'
import { loadSroPoBom } from '@/lib/bom'
import { loadModelSpecs } from '@/lib/model-spec'
import { buildSupplierSpec } from '@/lib/supplier-spec'
import { sanitiseDraft, toSpecDraft, type SpecDraft } from '@/lib/po-spec-draft'
import { entityLabel } from '@/lib/depot-constants'

/**
 * Where the barriers on this order end up, so the factory can pack and label to it.
 *
 * The depot order at the ROOT of the chain is what knows: supplier order to s.r.o. order to depot
 * order, and the depot is the one that asked for them. Null where the chain is shorter than that.
 */
export async function specDestination(poId: string): Promise<string | null> {
  const admin = createAdminClient()
  const read = async (id: string) =>
    (
      await admin
        .from('purchase_orders')
        .select('parent_po_id, from_entity')
        .eq('id', id)
        .maybeSingle<{ parent_po_id: string | null; from_entity: string | null }>()
    ).data ?? null

  const po = await read(poId)
  if (!po?.parent_po_id) return null
  const group = await read(po.parent_po_id)
  if (!group?.parent_po_id) return null
  const root = await read(group.parent_po_id)
  return root?.from_entity ? entityLabel(root.from_entity) : null
}

export interface SpecDocument {
  draft: SpecDraft
  /** What the generator produced when the draft was first created. */
  generated: SpecDraft | null
  /** False when nothing is stored and `draft` is a fresh generation nobody has kept. */
  saved: boolean
  updatedAt: string | null
  updatedByUid: string | null
  confirmedAt: string | null
  confirmedByUid: string | null
}

/**
 * The document as the Hub would generate it right now, from the parent order's exploded bill of
 * materials and the standing model specifications. Null when there is nothing to build from.
 */
export async function generateSpecDraft(
  poId: string,
  destination: string | null,
): Promise<SpecDraft | null> {
  const admin = createAdminClient()
  const { data: po } = await admin
    .from('purchase_orders')
    .select('parent_po_id')
    .eq('id', poId)
    .maybeSingle<{ parent_po_id: string | null }>()
  if (!po?.parent_po_id) return null

  const bom = await loadSroPoBom(po.parent_po_id, admin)
  if (!bom) return null

  const specs = await loadModelSpecs(admin)
  // The header is put on at print time, so the placeholders here never reach paper.
  const built = buildSupplierSpec(bom, '', undefined, '', destination, specs)
  if (built.products.length === 0) return null
  return toSpecDraft(built)
}

type Row = {
  draft: unknown
  generated: unknown
  updated_at: string | null
  updated_by_uid: string | null
  confirmed_at: string | null
  confirmed_by_uid: string | null
}

const COLUMNS = 'draft, generated, updated_at, updated_by_uid, confirmed_at, confirmed_by_uid'

/**
 * The document for an order: the saved one where there is one, otherwise a freshly generated draft
 * that has not been written anywhere. Null when the order has no bill of materials behind it.
 */
export async function loadSpecDocument(
  poId: string,
  destination: string | null,
): Promise<SpecDocument | null> {
  const admin = createAdminClient()
  const { data } = await admin
    .from('po_spec_document')
    .select(COLUMNS)
    .eq('po_id', poId)
    .maybeSingle<Row>()

  if (data) {
    return {
      draft: sanitiseDraft(data.draft),
      generated: data.generated ? sanitiseDraft(data.generated) : null,
      saved: true,
      updatedAt: data.updated_at,
      updatedByUid: data.updated_by_uid,
      confirmedAt: data.confirmed_at,
      confirmedByUid: data.confirmed_by_uid,
    }
  }

  const generated = await generateSpecDraft(poId, destination)
  if (!generated) return null
  return {
    draft: generated,
    generated,
    saved: false,
    updatedAt: null,
    updatedByUid: null,
    confirmedAt: null,
    confirmedByUid: null,
  }
}

/**
 * Save the draft.
 *
 * 🔴 Saving CLEARS the sign-off. A signature is on the words that were read, not on the row, so
 * changing one after somebody confirmed it sends it back for confirmation. Otherwise the PDF would
 * print a person's name against text they never saw.
 */
export async function saveSpecDraft(
  poId: string,
  draft: SpecDraft,
  actorUid: string,
  generated: SpecDraft | null,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const admin = createAdminClient()
  const { error } = await admin.from('po_spec_document').upsert(
    {
      po_id: poId,
      draft: sanitiseDraft(draft),
      generated: generated ? sanitiseDraft(generated) : null,
      updated_by_uid: actorUid,
      updated_at: new Date().toISOString(),
      confirmed_at: null,
      confirmed_by_uid: null,
    },
    { onConflict: 'po_id' },
  )
  if (error) return { ok: false, error: 'The specification could not be saved.' }
  return { ok: true }
}

/**
 * Sign the document off. One-shot: confirming an already confirmed document changes nothing, so a
 * double click cannot move the name or the date.
 */
export async function confirmSpecDraft(
  poId: string,
  actorUid: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const admin = createAdminClient()
  const { data, error } = await admin
    .from('po_spec_document')
    .update({ confirmed_at: new Date().toISOString(), confirmed_by_uid: actorUid })
    .eq('po_id', poId)
    .is('confirmed_at', null)
    .select('po_id')
    .maybeSingle()

  if (error) return { ok: false, error: 'The specification could not be confirmed.' }
  if (!data) return { ok: false, error: 'Save the specification before confirming it.' }
  return { ok: true }
}

/** Throw the saved document away and go back to what the order generates. */
export async function resetSpecDraft(
  poId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const admin = createAdminClient()
  const { error } = await admin.from('po_spec_document').delete().eq('po_id', poId)
  if (error) return { ok: false, error: 'The specification could not be reset.' }
  return { ok: true }
}

/**
 * Whether an order has a saved specification and whether it is signed, in ONE row read.
 *
 * Deliberately separate from loadSpecDocument, which falls back to generating a draft and so has
 * to explode a bill of materials. The order page only needs to know what to put on a badge.
 */
export async function specDocumentStatus(
  poId: string,
): Promise<{ saved: boolean; confirmedAt: string | null; confirmedByUid: string | null }> {
  const admin = createAdminClient()
  const { data } = await admin
    .from('po_spec_document')
    .select('confirmed_at, confirmed_by_uid')
    .eq('po_id', poId)
    .maybeSingle<{ confirmed_at: string | null; confirmed_by_uid: string | null }>()
  return {
    saved: Boolean(data),
    confirmedAt: data?.confirmed_at ?? null,
    confirmedByUid: data?.confirmed_by_uid ?? null,
  }
}

/** Display names for the uids on a document, in one read. */
export async function specActorNames(uids: (string | null)[]): Promise<Map<string, string>> {
  const wanted = [...new Set(uids.filter((u): u is string => Boolean(u)))]
  if (wanted.length === 0) return new Map()
  const admin = createAdminClient()
  const { data } = await admin.from('profiles').select('id, display_name').in('id', wanted)
  return new Map(
    ((data ?? []) as { id: string; display_name: string | null }[]).map((r) => [
      r.id,
      r.display_name ?? 'Unknown',
    ]),
  )
}
