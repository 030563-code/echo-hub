'use server'

import { z } from 'zod'
import { revalidatePath } from 'next/cache'
import { getAuthorizedUser } from '@/lib/authz'
import {
  authoriseInXero,
  clearChecked,
  customsPdfUrl,
  loadCustomsBill,
  markChecked,
  requestDraft,
  requestOcr,
  saveEditedReading,
} from '@/lib/customs/store.server'
import { customsPackageSchema } from '@/lib/customs/nippon-invoice'

/**
 * Dave's actions on a Nippon Express bill. EVERY export of a 'use server' file is a callable
 * endpoint, so each one checks customs.manage itself and trusts nothing the page sent but an id.
 */

export type CustomsActionResult = { success: true; message: string } | { success: false; error: string }

const idSchema = z.string().uuid()

async function gate(id: unknown) {
  const auth = await getAuthorizedUser()
  if (!auth.ok) return { ok: false as const, error: auth.error }
  if (!auth.capabilities.has('customs.manage')) {
    return { ok: false as const, error: 'Only the person who handles customs bills can do this.' }
  }
  const parsed = idSchema.safeParse(id)
  if (!parsed.success) return { ok: false as const, error: 'Invalid bill.' }
  return { ok: true as const, auth, id: parsed.data }
}

function refresh(id: string) {
  revalidatePath('/transport/customs')
  revalidatePath(`/transport/customs/${id}`)
}

/** Dave approves the bill in the Hub, which authorises the draft in Xero. */
export async function approveCustomsBill(id: unknown): Promise<CustomsActionResult> {
  const g = await gate(id)
  if (!g.ok) return { success: false, error: g.error }
  const result = await authoriseInXero(g.id, g.auth.user.id)
  refresh(g.id)
  if (!result.ok) return { success: false, error: result.error }
  return { success: true, message: 'Approved. The bill is authorised in Xero.' }
}

export async function retryCustomsReading(id: unknown): Promise<CustomsActionResult> {
  const g = await gate(id)
  if (!g.ok) return { success: false, error: g.error }
  const result = await requestOcr(g.id)
  refresh(g.id)
  if (!result.ok) return { success: false, error: result.error }
  return { success: true, message: 'Sent to be read again. It usually takes a minute or two.' }
}

export async function retryCustomsDraft(id: unknown): Promise<CustomsActionResult> {
  const g = await gate(id)
  if (!g.ok) return { success: false, error: g.error }
  const result = await requestDraft(g.id)
  refresh(g.id)
  if (!result.ok) return { success: false, error: result.error }
  return {
    success: true,
    message: result.existing ? 'That invoice was already in Xero, so it is linked, not copied.' : 'The draft bill is in Xero.',
  }
}

export async function customsPdfLink(
  id: unknown,
): Promise<{ success: true; url: string } | { success: false; error: string }> {
  const g = await gate(id)
  if (!g.ok) return { success: false, error: g.error }
  const row = await loadCustomsBill(g.id)
  if (!row) return { success: false, error: 'No such bill.' }
  const url = await customsPdfUrl(row)
  if (!url) return { success: false, error: 'Could not open the PDF. Please try again.' }
  return { success: true, url }
}

const NoteSchema = z.string().trim().min(1, 'Say in a few words what you found.').max(1000)

/** Dave has looked at what is flagged and is content with it, and says why. */
export async function markCustomsBillChecked(id: unknown, note: unknown): Promise<CustomsActionResult> {
  const g = await gate(id)
  if (!g.ok) return { success: false, error: g.error }
  const parsed = NoteSchema.safeParse(note)
  if (!parsed.success) return { success: false, error: parsed.error.issues[0]?.message ?? 'A note is needed.' }
  const result = await markChecked(g.id, g.auth.user.id, parsed.data)
  refresh(g.id)
  if (!result.ok) return { success: false, error: result.error }
  return { success: true, message: 'Marked as checked.' }
}

export async function undoCustomsBillChecked(id: unknown): Promise<CustomsActionResult> {
  const g = await gate(id)
  if (!g.ok) return { success: false, error: g.error }
  const result = await clearChecked(g.id)
  refresh(g.id)
  if (!result.ok) return { success: false, error: result.error }
  return { success: true, message: 'No longer marked as checked.' }
}

/** The reading corrected by hand, checked against the same shape Claude's reading must have. */
export async function saveCustomsReading(id: unknown, extraction: unknown): Promise<CustomsActionResult> {
  const g = await gate(id)
  if (!g.ok) return { success: false, error: g.error }
  const parsed = customsPackageSchema.safeParse(extraction)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    return { success: false, error: `${issue?.path.join(' ') || 'The reading'}: ${issue?.message ?? 'not valid'}` }
  }
  const result = await saveEditedReading(g.id, parsed.data, g.auth.user.id)
  refresh(g.id)
  if (!result.ok) return { success: false, error: result.error }
  if (result.spotId) revalidatePath(`/transport/${result.spotId}`)
  return { success: true, message: 'Saved. The checks are worked again from what you typed.' }
}
