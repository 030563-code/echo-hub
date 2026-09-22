import 'server-only'

/**
 * Reading and writing the -3 priced order for one purchase order. The document itself lives in
 * po-priced-draft.ts, which is pure; this is only the trip to the database.
 *
 * Three states, exactly like the -1 in po-spec-store.ts:
 *
 *   NOTHING SAVED    generated from the bill of materials every time it is printed.
 *   SAVED            prints what was saved, line for line. Not yet signed.
 *   CONFIRMED        the order page says who signed it and when.
 *
 * Nothing on the printed document says which state it is in (Dean, 22 Sep 2026: no tags on a
 * client-facing sheet); the order page and the editor do.
 *
 * Generation is NOT here. bamida-po-document.ts builds the priced order and reads the saved draft
 * through this module, so this module cannot import that one back.
 */

import { createAdminClient } from '@/lib/supabase/admin'
import { sanitisePricedDraft, type PricedDraft } from '@/lib/po-priced-draft'

export interface PricedDocument {
  draft: PricedDraft
  /** What the generator produced when the draft was first created. */
  generated: PricedDraft | null
  updatedAt: string | null
  updatedByUid: string | null
  confirmedAt: string | null
  confirmedByUid: string | null
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

/** The SAVED document for an order, or null when nobody has saved one. */
export async function readPricedDocument(poId: string): Promise<PricedDocument | null> {
  const admin = createAdminClient()
  const { data } = await admin.from('po_priced_document').select(COLUMNS).eq('po_id', poId).maybeSingle<Row>()
  if (!data) return null
  return {
    draft: sanitisePricedDraft(data.draft),
    generated: data.generated ? sanitisePricedDraft(data.generated) : null,
    updatedAt: data.updated_at,
    updatedByUid: data.updated_by_uid,
    confirmedAt: data.confirmed_at,
    confirmedByUid: data.confirmed_by_uid,
  }
}

/**
 * Write the draft, signed or unsigned, in ONE statement.
 *
 * 🔴 An unsigned save CLEARS any existing sign-off, and confirming writes the content and the
 * signature together, for the reasons po-spec-store.ts gives: a signature belongs to the lines
 * that were read, and a correct generated document must not need a pointless edit to be signed.
 */
export async function writePricedDraft(
  poId: string,
  draft: PricedDraft,
  actorUid: string,
  generated: PricedDraft | null,
  confirm: boolean,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const now = new Date().toISOString()
  const admin = createAdminClient()
  const { error } = await admin.from('po_priced_document').upsert(
    {
      po_id: poId,
      draft: sanitisePricedDraft(draft),
      generated: generated ? sanitisePricedDraft(generated) : null,
      updated_by_uid: actorUid,
      updated_at: now,
      confirmed_at: confirm ? now : null,
      confirmed_by_uid: confirm ? actorUid : null,
    },
    { onConflict: 'po_id' },
  )
  if (error) {
    return { ok: false, error: confirm ? 'The priced order could not be confirmed.' : 'The priced order could not be saved.' }
  }
  return { ok: true }
}

/** Throw the saved document away and go back to what the order generates. */
export async function resetPricedDraft(poId: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const admin = createAdminClient()
  const { error } = await admin.from('po_priced_document').delete().eq('po_id', poId)
  if (error) return { ok: false, error: 'The priced order could not be reset.' }
  return { ok: true }
}

/** Whether an order has a saved priced document and whether it is signed, in ONE row read. */
export async function pricedDocumentStatus(
  poId: string,
): Promise<{ saved: boolean; confirmedAt: string | null; confirmedByUid: string | null }> {
  const admin = createAdminClient()
  const { data } = await admin
    .from('po_priced_document')
    .select('confirmed_at, confirmed_by_uid')
    .eq('po_id', poId)
    .maybeSingle<{ confirmed_at: string | null; confirmed_by_uid: string | null }>()
  return { saved: Boolean(data), confirmedAt: data?.confirmed_at ?? null, confirmedByUid: data?.confirmed_by_uid ?? null }
}

/**
 * The saved priced drafts under each of these SRO orders, keyed by the SRO order's id. The bill
 * of materials page builds one priced document per SRO order and the saved one hangs off the
 * manufacturing child, so this is the join it needs in two reads rather than one per order.
 */
export async function pricedDraftsBySroOrder(sroPoIds: string[]): Promise<Record<string, PricedDraft>> {
  if (sroPoIds.length === 0) return {}
  const admin = createAdminClient()
  const { data: children } = await admin
    .from('purchase_orders')
    .select('id, parent_po_id')
    .eq('leg', 'SRO_TO_SUPPLIER')
    .in('parent_po_id', sroPoIds)
  const parentOf = new Map<string, string>()
  for (const c of (children ?? []) as { id: string; parent_po_id: string | null }[]) {
    if (c.parent_po_id) parentOf.set(c.id, c.parent_po_id)
  }
  if (parentOf.size === 0) return {}

  const { data: docs } = await admin.from('po_priced_document').select('po_id, draft').in('po_id', [...parentOf.keys()])
  const out: Record<string, PricedDraft> = {}
  for (const row of (docs ?? []) as { po_id: string; draft: unknown }[]) {
    const sro = parentOf.get(row.po_id)
    if (sro) out[sro] = sanitisePricedDraft(row.draft)
  }
  return out
}
