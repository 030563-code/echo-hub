'use server'

/**
 * Editing and signing the -1 manufacturing specification.
 *
 * Dean, 17 Sep 2026: "Juraj and Martin should really be able to edit all these PO's since theres
 * so many variables. It should be generated and prepopulated for him then he can edit and add
 * lines to these then it saves to the PO and prints properly. That way nothing goes unsigned."
 *
 * Reading needs po.view, which is what the order page already needs. Writing needs bom.edit, the
 * same capability that guards model_spec and the master prices, because editing this is editing
 * what the factory is told to put into a barrier. Juraj and the Operations account both hold it;
 * sales and production accounts do not.
 *
 * 🔴 Every export of a 'use server' file is a public endpoint. All four gate on the session, then
 * the capability, then that the caller's organisation holds this chain, before touching anything.
 */

import { z } from 'zod'
import { revalidatePath } from 'next/cache'
import { getAuthorizedUser } from '@/lib/authz'
import { poChainHeldBy } from '@/lib/po-organisations'
import { sanitiseDraft, specDrift, type SpecDraft, type SpecDrift } from '@/lib/po-spec-draft'
import {
  confirmSpecDraft,
  generateSpecDraft,
  loadSpecDocument,
  resetSpecDraft,
  saveSpecDraft,
  specActorNames,
  specDestination,
} from '@/lib/po-spec-store'

const PoId = z.object({ poId: z.string().uuid('Invalid PO id') })

export interface SpecEditorState {
  draft: SpecDraft
  /** What the order generates right now, for the Reset button and the drift notice. */
  generated: SpecDraft | null
  saved: boolean
  updatedAt: string | null
  updatedBy: string | null
  confirmedAt: string | null
  confirmedBy: string | null
  /** What the saved document says that the order no longer does. Never applied on its own. */
  drift: SpecDrift[]
  canEdit: boolean
}

export type SpecEditorResult =
  | { ok: true; state: SpecEditorState }
  | { ok: false; error: string }

export type SpecWriteResult = { ok: true } | { ok: false; error: string }

/** Session, capability and chain, in that order. Every export below starts here. */
async function gate(poId: string, need: 'read' | 'write') {
  const auth = await getAuthorizedUser()
  if (!auth.ok) return { ok: false as const, error: auth.error }
  if (!auth.capabilities.has('po.view')) {
    return { ok: false as const, error: 'Forbidden: missing po.view capability' }
  }
  const canEdit = auth.capabilities.has('bom.edit')
  if (need === 'write' && !canEdit) {
    return { ok: false as const, error: 'Forbidden: editing the specification needs bom.edit' }
  }
  if (!(await poChainHeldBy(poId, auth.profile.organisations))) {
    return { ok: false as const, error: 'That purchase order no longer exists.' }
  }
  return { ok: true as const, uid: auth.user.id, canEdit }
}

/** The document as it stands, plus everything the editor needs to explain it. */
export async function loadSpecEditor(input: { poId: string }): Promise<SpecEditorResult> {
  const parsed = PoId.safeParse(input)
  if (!parsed.success) return { ok: false, error: 'Invalid PO id' }
  const allowed = await gate(parsed.data.poId, 'read')
  if (!allowed.ok) return { ok: false, error: allowed.error }

  const destination = await specDestination(parsed.data.poId)
  const document = await loadSpecDocument(parsed.data.poId, destination)
  if (!document) {
    return {
      ok: false,
      error: 'There is no bill of materials behind this order yet, so there is nothing to specify.',
    }
  }

  // Only worth a second generation once something has been saved: before then the draft IS the
  // generation and comparing it with itself would find nothing.
  const generated = document.saved
    ? await generateSpecDraft(parsed.data.poId, destination)
    : document.draft

  const names = await specActorNames([document.updatedByUid, document.confirmedByUid])
  return {
    ok: true,
    state: {
      draft: document.draft,
      generated,
      saved: document.saved,
      updatedAt: document.updatedAt,
      updatedBy: document.updatedByUid ? (names.get(document.updatedByUid) ?? null) : null,
      confirmedAt: document.confirmedAt,
      confirmedBy: document.confirmedByUid ? (names.get(document.confirmedByUid) ?? null) : null,
      drift: generated ? specDrift(document.draft, generated) : [],
      canEdit: allowed.canEdit,
    },
  }
}

/**
 * Save what is on the screen.
 *
 * The client's draft never reaches the database unvalidated: `sanitiseDraft` drops malformed rows,
 * caps every field, and recomputes the pallet count and the material totals from the quantity, so
 * a hand-typed total cannot send the wrong amount of fabric to the floor.
 */
export async function saveSpecDocument(input: {
  poId: string
  draft: unknown
}): Promise<SpecWriteResult> {
  const parsed = PoId.safeParse(input)
  if (!parsed.success) return { ok: false, error: 'Invalid PO id' }
  const allowed = await gate(parsed.data.poId, 'write')
  if (!allowed.ok) return { ok: false, error: allowed.error }

  const draft = sanitiseDraft(input.draft)
  if (draft.products.length === 0) {
    return { ok: false, error: 'A specification with no products on it would tell the factory nothing.' }
  }

  // Recorded alongside the draft the FIRST time, so a later hand edit can be told from an
  // untouched document without going back to the bill of materials.
  const existing = await loadSpecDocument(parsed.data.poId, draft.destination)
  const generated = existing?.generated ?? existing?.draft ?? null

  const written = await saveSpecDraft(parsed.data.poId, draft, allowed.uid, generated)
  if (!written.ok) return written

  revalidatePath(`/purchase-orders/${parsed.data.poId}`)
  revalidatePath(`/purchase-orders/${parsed.data.poId}/specification`)
  return { ok: true }
}

/** Sign it off. From here the PDF prints a name and a date instead of the red warning. */
export async function confirmSpecDocument(input: { poId: string }): Promise<SpecWriteResult> {
  const parsed = PoId.safeParse(input)
  if (!parsed.success) return { ok: false, error: 'Invalid PO id' }
  const allowed = await gate(parsed.data.poId, 'write')
  if (!allowed.ok) return { ok: false, error: allowed.error }

  const done = await confirmSpecDraft(parsed.data.poId, allowed.uid)
  if (!done.ok) return done

  revalidatePath(`/purchase-orders/${parsed.data.poId}`)
  revalidatePath(`/purchase-orders/${parsed.data.poId}/specification`)
  return { ok: true }
}

/**
 * Throw the saved document away and go back to what the order generates.
 *
 * Destructive and says so at the button: every hand edit and any sign-off go with it. It is the
 * only way to pick up a changed order line without retyping the document, which is why it exists.
 */
export async function resetSpecDocument(input: { poId: string }): Promise<SpecWriteResult> {
  const parsed = PoId.safeParse(input)
  if (!parsed.success) return { ok: false, error: 'Invalid PO id' }
  const allowed = await gate(parsed.data.poId, 'write')
  if (!allowed.ok) return { ok: false, error: allowed.error }

  const done = await resetSpecDraft(parsed.data.poId)
  if (!done.ok) return done

  revalidatePath(`/purchase-orders/${parsed.data.poId}`)
  revalidatePath(`/purchase-orders/${parsed.data.poId}/specification`)
  return { ok: true }
}
