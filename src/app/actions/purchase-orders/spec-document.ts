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
  generateSpecDraft,
  loadColourOptions,
  loadSpecDocument,
  resetSpecDraft,
  specActorNames,
  specDestination,
  writeSpecDraft,
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
  /**
   * Fabric family to the colours it can be ordered in (PC350FR, P200), for the colour picker on a
   * material line. Plain JSON here because this crosses to the browser; the rules that read it take
   * the Map form (material-colours.ts).
   */
  colourOptions: Record<string, string[]>
}

export type SpecEditorResult =
  | { ok: true; state: SpecEditorState }
  | { ok: false; error: string }

/**
 * A write hands back the WHOLE new state rather than an acknowledgement.
 *
 * The editor holds the draft in React state, so `router.refresh()` alone would re-render the
 * server component without the client ever seeing the new confirmation, and the banner would go on
 * claiming the old one. Returning the state means the screen shows what the database says instead
 * of what the browser guessed.
 */
export type SpecWriteResult = SpecEditorResult

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

/** Everything the editor needs, once the caller has been allowed through. */
async function editorState(poId: string, canEdit: boolean): Promise<SpecEditorResult> {
  const destination = await specDestination(poId)
  const document = await loadSpecDocument(poId, destination)
  if (!document) {
    return {
      ok: false,
      error: 'There is no bill of materials behind this order yet, so there is nothing to specify.',
    }
  }

  // Only worth a second generation once something has been saved: before then the draft IS the
  // generation and comparing it with itself would find nothing.
  const generated = document.saved ? await generateSpecDraft(poId, destination) : document.draft

  const [names, colourOptions] = await Promise.all([
    specActorNames([document.updatedByUid, document.confirmedByUid]),
    loadColourOptions(),
  ])
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
      canEdit,
      colourOptions,
    },
  }
}

/** The document as it stands, plus everything the editor needs to explain it. */
export async function loadSpecEditor(input: { poId: string }): Promise<SpecEditorResult> {
  const parsed = PoId.safeParse(input)
  if (!parsed.success) return { ok: false, error: 'Invalid PO id' }
  const allowed = await gate(parsed.data.poId, 'read')
  if (!allowed.ok) return { ok: false, error: allowed.error }
  return editorState(parsed.data.poId, allowed.canEdit)
}

/**
 * Write the document, signed or not.
 *
 * 🔴 CONFIRMING DOES NOT NEED A PRIOR SAVE. Dean, 17 Sep 2026: "I cant press confirm as it is
 * greyed out. I need to edit something and then it appears what if the first one is correct?" The
 * commonest case is exactly that: the generated document is right, somebody reads it and signs it.
 * Content and signature go down together, so there is no half state either.
 */
async function write(poId: string, rawDraft: unknown, confirm: boolean): Promise<SpecWriteResult> {
  const allowed = await gate(poId, 'write')
  if (!allowed.ok) return { ok: false, error: allowed.error }

  const draft = sanitiseDraft(rawDraft)
  if (draft.products.length === 0) {
    return { ok: false, error: 'A specification with no products on it would tell the factory nothing.' }
  }

  // Recorded alongside the draft the FIRST time, so a later hand edit can be told from an
  // untouched document without going back to the bill of materials.
  const existing = await loadSpecDocument(poId, draft.destination)
  const generated = existing?.generated ?? existing?.draft ?? null

  const written = await writeSpecDraft(poId, draft, allowed.uid, generated, confirm)
  if (!written.ok) return written

  revalidatePath(`/purchase-orders/${poId}`)
  revalidatePath(`/purchase-orders/${poId}/specification`)
  return editorState(poId, allowed.canEdit)
}

/** Save without signing. Any existing sign-off is withdrawn: the words changed. */
export async function saveSpecDocument(input: {
  poId: string
  draft: unknown
}): Promise<SpecWriteResult> {
  const parsed = PoId.safeParse(input)
  if (!parsed.success) return { ok: false, error: 'Invalid PO id' }
  return write(parsed.data.poId, input.draft, false)
}

/** Sign it off. From here the PDF prints a name and a date instead of the red warning. */
export async function confirmSpecDocument(input: {
  poId: string
  draft: unknown
}): Promise<SpecWriteResult> {
  const parsed = PoId.safeParse(input)
  if (!parsed.success) return { ok: false, error: 'Invalid PO id' }
  return write(parsed.data.poId, input.draft, true)
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
  if (!done.ok) return { ok: false, error: done.error }

  revalidatePath(`/purchase-orders/${parsed.data.poId}`)
  revalidatePath(`/purchase-orders/${parsed.data.poId}/specification`)
  return editorState(parsed.data.poId, allowed.canEdit)
}
