'use server'

import { z } from 'zod'
import { revalidatePath } from 'next/cache'
import { getAuthorizedUser } from '@/lib/authz'
import {
  authoriseInXero,
  customsPdfUrl,
  loadCustomsBill,
  requestDraft,
  requestOcr,
} from '@/lib/customs/store.server'

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
