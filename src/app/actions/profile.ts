'use server'

/**
 * Your own profile: job title, bio and photo.
 *
 * EVERY export of a 'use server' file is a callable endpoint, so each one here
 * authenticates first and acts on the SESSION user only. None of them accepts a
 * user id: there is no way to call these against somebody else's profile.
 *
 * The job title and bio go through the session client, so RLS (own row only)
 * and the column grant (authenticated may update display_name, bio and
 * job_title, nothing else) are both enforcers. The photo cannot: the avatars
 * bucket has no storage.objects policies and avatar_updated_at is granted to
 * nobody, so those writes use the service-role client, and only after the
 * bytes have been checked to really be a JPEG, PNG or WebP image. Same doctrine
 * as purchase-orders/attachments.ts.
 */

import { z } from 'zod'
import { revalidatePath } from 'next/cache'
import { createServerClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { getAuthorizedUser } from '@/lib/authz'
import { deletePageState } from '@/lib/page-state-server'
import { PROFILE_DETAILS_KEY } from '@/lib/page-drafts'
import { AVATAR_BUCKET, AVATAR_MAX_BYTES, BIO_MAX, JOB_TITLE_MAX, sniffImageType } from '@/lib/profile/avatar'

type ProfileResult = { success: true } | { success: false; error: string }

const NOT_SIGNED_IN = 'You are not signed in. Sign in again and retry.'

/** Empty after trimming means "clear it", stored as null rather than ''. */
const orNull = (value: string) => (value === '' ? null : value)

const detailsInput = z.object({
  jobTitle: z
    .string()
    .trim()
    .max(JOB_TITLE_MAX, `Your job title can be at most ${JOB_TITLE_MAX} characters.`)
    .refine((v) => !/[\r\n]/.test(v), 'Your job title must fit on one line.')
    .transform(orNull),
  bio: z
    .string()
    .trim()
    .max(BIO_MAX, `Your bio can be at most ${BIO_MAX} characters.`)
    .transform(orNull),
})

export async function updateProfileDetails(input: { jobTitle: string; bio: string }): Promise<ProfileResult> {
  const auth = await getAuthorizedUser()
  if (!auth.ok) return { success: false, error: NOT_SIGNED_IN }

  const parsed = detailsInput.safeParse(input)
  if (!parsed.success) {
    return { success: false, error: parsed.error.issues[0]?.message ?? 'Your details could not be saved.' }
  }

  const supabase = await createServerClient()
  const { data, error } = await supabase
    .from('profiles')
    .update({ job_title: parsed.data.jobTitle, bio: parsed.data.bio })
    .eq('id', auth.user.id)
    .select('id')
  if (error) {
    console.error('updateProfileDetails failed', error.message)
    return { success: false, error: 'Your details could not be saved. Try again in a moment.' }
  }
  // RLS turns a refused update into zero rows rather than an error.
  if (!data || data.length === 0) {
    return { success: false, error: 'Your details could not be saved: your profile was not found.' }
  }

  // The draft is spent. Cleared here too, for a browser that never got the
  // answer back.
  await deletePageState(PROFILE_DETAILS_KEY)
  revalidatePath('/', 'layout')
  return { success: true }
}

export async function uploadAvatar(formData: FormData): Promise<ProfileResult> {
  const auth = await getAuthorizedUser()
  if (!auth.ok) return { success: false, error: NOT_SIGNED_IN }

  const file = formData.get('file')
  if (!(file instanceof File) || file.size === 0) {
    return { success: false, error: 'No photo was sent. Choose a photo and try again.' }
  }
  if (file.size > AVATAR_MAX_BYTES) {
    return { success: false, error: 'That photo is larger than 512 KB after resizing. Try a different photo.' }
  }

  const bytes = new Uint8Array(await file.arrayBuffer())
  // The declared file type is whatever the client said, so it is ignored. The
  // stored content type is what the bytes actually are.
  const contentType = sniffImageType(bytes)
  if (!contentType) {
    return { success: false, error: 'That file is not a JPEG, PNG or WebP image.' }
  }

  const admin = createAdminClient()
  // The object key is the user id and nothing else, so nobody can name a
  // folder or a file, and a new photo replaces the old one in place.
  const { error: upErr } = await admin.storage.from(AVATAR_BUCKET).upload(auth.user.id, bytes, {
    contentType,
    upsert: true,
    cacheControl: 'no-cache',
  })
  if (upErr) {
    console.error('uploadAvatar storage upload failed', upErr.message)
    return { success: false, error: 'Your photo could not be uploaded. Try again in a moment.' }
  }

  const { data: rows, error: rowErr } = await admin
    .from('profiles')
    .update({ avatar_updated_at: new Date().toISOString() })
    .eq('id', auth.user.id)
    .select('id')
  if (rowErr || !rows || rows.length === 0) {
    console.error('uploadAvatar profile update failed', rowErr?.message ?? 'no profile row')
    return { success: false, error: 'Your photo was uploaded but could not be saved to your profile. Try again.' }
  }

  revalidatePath('/', 'layout')
  return { success: true }
}

export async function removeAvatar(): Promise<ProfileResult> {
  const auth = await getAuthorizedUser()
  if (!auth.ok) return { success: false, error: NOT_SIGNED_IN }

  const admin = createAdminClient()
  const { error: rmErr } = await admin.storage.from(AVATAR_BUCKET).remove([auth.user.id])
  if (rmErr) {
    console.error('removeAvatar storage remove failed', rmErr.message)
    return { success: false, error: 'Your photo could not be removed. Try again in a moment.' }
  }

  const { data: rows, error: rowErr } = await admin
    .from('profiles')
    .update({ avatar_updated_at: null })
    .eq('id', auth.user.id)
    .select('id')
  if (rowErr || !rows || rows.length === 0) {
    console.error('removeAvatar profile update failed', rowErr?.message ?? 'no profile row')
    return { success: false, error: 'Your photo was deleted but your profile still shows it. Try again.' }
  }

  revalidatePath('/', 'layout')
  return { success: true }
}
