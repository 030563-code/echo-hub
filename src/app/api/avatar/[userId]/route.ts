import { z } from 'zod'
import type { NextRequest } from 'next/server'
import { getAuthorizedUser } from '@/lib/authz'
import { createAdminClient } from '@/lib/supabase/admin'
import { AVATAR_BUCKET, avatarVersion, sniffImageType } from '@/lib/profile/avatar'

// ---------------------------------------------------------------------------
// GET /api/avatar/<userId>: a profile photo, served same-origin.
//
// Same-origin because the CSP allows img-src 'self' only, so a Storage url
// would be blocked. The middleware session-gates this path (it is not in
// PUBLIC_PATHS); the check below is the authorisation on top of that.
//
// Who may see a photo: its owner, or a super admin. Everyone else gets 404, the
// same answer as "no photo", so the route never says whether one exists.
//
// The database decides whether there is a photo, not the bucket. The route
// reads avatar_updated_at before it touches Storage and answers 404 while it is
// null, so an object a failed removal left behind is never served. It also
// decides caching: only a url whose version is the CURRENT one may be cached
// for a year, and any other version, or none, is fetched fresh every time. The
// upload puts the bytes in before it changes the version, so a url cached for a
// year never holds a photo older than the version it names.
//
// The bytes are sniffed again on the way OUT. The upload action already
// refused anything that was not a JPEG, PNG or WebP, but the bucket is the
// thing being trusted here, and an object that got in some other way must not
// be served as whatever it claims to be. The response is also sandboxed with
// its own CSP and nosniff, so even a bad object opened directly cannot run.
// ---------------------------------------------------------------------------

export const dynamic = 'force-dynamic'

const userIdSchema = z.string().uuid()

function notFound(): Response {
  return new Response('Not found', {
    status: 404,
    headers: { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' },
  })
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ userId: string }> }) {
  const auth = await getAuthorizedUser()
  if (!auth.ok) {
    return new Response('Unauthorized', { status: 401, headers: { 'Cache-Control': 'private, no-store' } })
  }

  const { userId } = await params
  const parsed = userIdSchema.safeParse(userId)
  if (!parsed.success) return notFound()

  const allowed = parsed.data === auth.user.id || auth.profile.is_super_admin
  if (!allowed) return notFound()

  const admin = createAdminClient()
  const { data: row, error: rowErr } = await admin
    .from('profiles')
    .select('avatar_updated_at')
    .eq('id', parsed.data)
    .maybeSingle()
  if (rowErr || !row || row.avatar_updated_at === null) return notFound()
  const version = avatarVersion(row.avatar_updated_at)
  if (version === null) return notFound()

  const { data, error } = await admin.storage.from(AVATAR_BUCKET).download(parsed.data)
  if (error || !data) return notFound()

  const bytes = new Uint8Array(await data.arrayBuffer())
  const contentType = sniffImageType(bytes)
  if (!contentType) return notFound()

  // The same number avatarSrc() put in the url. Only the current version is
  // immutable; a stale version or no version at all must always be fetched fresh.
  const isCurrent = request.nextUrl.searchParams.get('v') === String(version)

  return new Response(bytes, {
    status: 200,
    headers: {
      'Content-Type': contentType,
      'Cache-Control': isCurrent ? 'private, max-age=31536000, immutable' : 'private, no-store',
      'Content-Disposition': 'inline',
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'X-Content-Type-Options': 'nosniff',
    },
  })
}
