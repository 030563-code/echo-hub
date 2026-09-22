'use server'

/**
 * Editing and signing the -3 priced (accounting) order.
 *
 * Dean, 22 Sep 2026, on Martin's "is it possible to change purchase order with prices?": "where
 * do they edit the priced PO?" Same shape as spec-document.ts. Reading needs po.view AND
 * cost.view, because every line on it is a price. Writing needs bom.edit as well, the capability
 * that already guards the master prices and the -1. Juraj and the Operations account hold all
 * three; sales and production accounts do not.
 *
 * 🔴 Every export of a 'use server' file is a public endpoint. All four gate on the session, then
 * the capabilities, then that the caller's organisation holds this chain, before touching anything.
 */

import { z } from 'zod'
import { revalidatePath } from 'next/cache'
import { getAuthorizedUser } from '@/lib/authz'
import { poChainHeldBy } from '@/lib/po-organisations'
import {
  pricedDrift,
  sanitisePricedDraft,
  toPricedDraft,
  type PricedDraft,
  type PricedDrift,
} from '@/lib/po-priced-draft'
import { readPricedDocument, resetPricedDraft, writePricedDraft } from '@/lib/po-priced-store'
import { specActorNames } from '@/lib/po-spec-store'
import { generatePricedOrder } from '@/lib/bamida-po-document'

const PoId = z.object({ poId: z.string().uuid('Invalid PO id') })

export interface PricedEditorState {
  /** The document number the -3 prints, EBSRO8001-3. */
  documentNumber: string
  draft: PricedDraft
  /** What the order generates right now, for the Reset button and the drift notice. */
  generated: PricedDraft | null
  saved: boolean
  updatedAt: string | null
  updatedBy: string | null
  confirmedAt: string | null
  confirmedBy: string | null
  drift: PricedDrift[]
  canEdit: boolean
}

export type PricedEditorResult = { ok: true; state: PricedEditorState } | { ok: false; error: string }

/** Session, capabilities and chain, in that order. Every export below starts here. */
async function gate(poId: string, need: 'read' | 'write') {
  const auth = await getAuthorizedUser()
  if (!auth.ok) return { ok: false as const, error: auth.error }
  if (!auth.capabilities.has('po.view')) {
    return { ok: false as const, error: 'Forbidden: missing po.view capability' }
  }
  if (!auth.capabilities.has('cost.view')) {
    return { ok: false as const, error: 'Forbidden: the priced order needs cost.view' }
  }
  const canEdit = auth.capabilities.has('bom.edit')
  if (need === 'write' && !canEdit) {
    return { ok: false as const, error: 'Forbidden: editing the priced order needs bom.edit' }
  }
  if (!(await poChainHeldBy(poId, auth.profile.organisations))) {
    return { ok: false as const, error: 'That purchase order no longer exists.' }
  }
  return { ok: true as const, uid: auth.user.id, canEdit }
}

function refusal(reason: 'no_parent' | 'no_bom' | 'no_lines' | 'no_shipment'): string {
  return reason === 'no_parent'
    ? 'This order has no parent order, so there is no bill of materials to price from.'
    : reason === 'no_bom'
      ? 'The bill of materials for this order could not be read.'
      : 'The bill of materials produced no lines for this order.'
}

/** Everything the editor needs, once the caller has been allowed through. */
async function editorState(poId: string, canEdit: boolean): Promise<PricedEditorResult> {
  const generated = await generatePricedOrder(poId)
  if (!generated.ok) return { ok: false, error: refusal(generated.reason) }
  const fresh = toPricedDraft(generated.document)

  const saved = await readPricedDocument(poId)
  const names = await specActorNames([saved?.updatedByUid ?? null, saved?.confirmedByUid ?? null])
  return {
    ok: true,
    state: {
      documentNumber: generated.document.poNumber,
      draft: saved?.draft ?? fresh,
      generated: fresh,
      saved: Boolean(saved),
      updatedAt: saved?.updatedAt ?? null,
      updatedBy: saved?.updatedByUid ? (names.get(saved.updatedByUid) ?? null) : null,
      confirmedAt: saved?.confirmedAt ?? null,
      confirmedBy: saved?.confirmedByUid ? (names.get(saved.confirmedByUid) ?? null) : null,
      drift: saved ? pricedDrift(saved.draft, fresh) : [],
      canEdit,
    },
  }
}

/** The document as it stands, plus everything the editor needs to explain it. */
export async function loadPricedEditor(input: { poId: string }): Promise<PricedEditorResult> {
  const parsed = PoId.safeParse(input)
  if (!parsed.success) return { ok: false, error: 'Invalid PO id' }
  const allowed = await gate(parsed.data.poId, 'read')
  if (!allowed.ok) return { ok: false, error: allowed.error }
  return editorState(parsed.data.poId, allowed.canEdit)
}

/**
 * Write the document, signed or not. Confirming does not need a prior save, for the reason
 * spec-document.ts gives: a generated document that is already right is signed as it stands.
 */
async function write(poId: string, rawDraft: unknown, confirm: boolean): Promise<PricedEditorResult> {
  const allowed = await gate(poId, 'write')
  if (!allowed.ok) return { ok: false, error: allowed.error }

  const draft = sanitisePricedDraft(rawDraft)
  if (draft.lines.length === 0) {
    return { ok: false, error: 'A priced order with no lines on it would bill nothing.' }
  }

  // Recorded alongside the draft the FIRST time, so a later hand edit can be told from an
  // untouched document without going back to the bill of materials.
  const existing = await readPricedDocument(poId)
  let generated = existing?.generated ?? null
  if (!generated) {
    const fresh = await generatePricedOrder(poId)
    generated = fresh.ok ? toPricedDraft(fresh.document) : null
  }

  const written = await writePricedDraft(poId, draft, allowed.uid, generated, confirm)
  if (!written.ok) return written

  revalidatePath(`/purchase-orders/${poId}`)
  revalidatePath(`/purchase-orders/${poId}/priced`)
  revalidatePath('/bom')
  return editorState(poId, allowed.canEdit)
}

/** Save without signing. Any existing sign-off is withdrawn: the lines changed. */
export async function savePricedDocument(input: { poId: string; draft: unknown }): Promise<PricedEditorResult> {
  const parsed = PoId.safeParse(input)
  if (!parsed.success) return { ok: false, error: 'Invalid PO id' }
  return write(parsed.data.poId, input.draft, false)
}

/** Sign it off. The order page shows who, and when. */
export async function confirmPricedDocument(input: { poId: string; draft: unknown }): Promise<PricedEditorResult> {
  const parsed = PoId.safeParse(input)
  if (!parsed.success) return { ok: false, error: 'Invalid PO id' }
  return write(parsed.data.poId, input.draft, true)
}

/** Throw the saved document away and go back to what the order generates. */
export async function resetPricedDocument(input: { poId: string }): Promise<PricedEditorResult> {
  const parsed = PoId.safeParse(input)
  if (!parsed.success) return { ok: false, error: 'Invalid PO id' }
  const allowed = await gate(parsed.data.poId, 'write')
  if (!allowed.ok) return { ok: false, error: allowed.error }

  const done = await resetPricedDraft(parsed.data.poId)
  if (!done.ok) return { ok: false, error: done.error }

  revalidatePath(`/purchase-orders/${parsed.data.poId}`)
  revalidatePath(`/purchase-orders/${parsed.data.poId}/priced`)
  revalidatePath('/bom')
  return editorState(parsed.data.poId, allowed.canEdit)
}
