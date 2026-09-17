'use server'

/**
 * Adding somebody to the send address book.
 *
 * Dean, 17 Sep 2026: "the ability to add more to a library in supabase that adds to the tickbox".
 *
 * 🔴 Gated on po.create, the same capability as raising an order, because choosing who hears about
 * our purchase orders is the same kind of decision as raising one. And a contact added here is
 * never required and never pre-ticked: `addSendContact` decides that, not the caller, so nobody
 * can put themselves on every order the Hub ever sends by posting to this endpoint.
 */

import { z } from 'zod'
import { revalidatePath } from 'next/cache'
import { getAuthorizedUser } from '@/lib/authz'
import { addSendContact } from '@/lib/send-contacts'

const Input = z.object({
  channel: z.enum(['manufacturing', 'cargo']),
  address: z.string().trim().min(3).max(200),
  displayName: z.string().trim().max(120).optional(),
  organisation: z.string().trim().max(120).optional(),
  field: z.enum(['to', 'cc']),
})

export type AddContactResult = { ok: true } | { ok: false; error: string }

export async function addContactToBook(input: {
  channel: 'manufacturing' | 'cargo'
  address: string
  displayName?: string
  organisation?: string
  field: 'to' | 'cc'
}): Promise<AddContactResult> {
  const auth = await getAuthorizedUser()
  if (!auth.ok) return { ok: false, error: auth.error }
  if (!auth.capabilities.has('po.create')) {
    return { ok: false, error: 'Forbidden: adding a contact needs po.create' }
  }

  const parsed = Input.safeParse(input)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid contact' }
  }

  const added = await addSendContact({
    channel: parsed.data.channel,
    address: parsed.data.address,
    displayName: parsed.data.displayName ?? null,
    organisation: parsed.data.organisation ?? null,
    field: parsed.data.field,
    actorUid: auth.user.id,
  })
  if (!added.ok) return { ok: false, error: added.error }

  revalidatePath('/purchase-orders', 'layout')
  return { ok: true }
}
