import { getAuthorizedUser } from '@/lib/authz'
import { isOrgCode } from '@/lib/organisations'
import { ACTIVE_ORG_COOKIE, ACTIVE_ORG_COOKIE_MAX_AGE, safeNextPath } from '@/lib/active-organisation'
import { redirectToPath } from '@/lib/same-site-redirect'

/**
 * Switch the active organisation: GET /org/EB-CANADA?next=/invoicing
 *
 * The sidebar's organisation rows are plain links here. The handler checks
 * the person actually holds the organisation, sets the hub_org cookie and
 * sends them on to `next`, which is only ever a path on this site.
 *
 * A GET that sets a cookie is fine here because of what the cookie is: a
 * preference inside the caller's own allowed set. The page that follows
 * re-resolves it against the live grants (activeOrganisation), so a stale or
 * planted value can never widen anything. Session-gated by the middleware
 * like every other path, which is why an unauthenticated hit never reaches
 * this code.
 *
 * A full navigation on purpose, not a client-side transition: the header
 * badge and every sidebar sub-list live in the layout, and the whole tree has
 * to re-render with the new organisation.
 */
export const dynamic = 'force-dynamic'

export async function GET(request: Request, context: { params: Promise<{ code: string }> }) {
  const { code } = await context.params
  // Read for its query only. 🔴 Its HOST is not to be trusted on Netlify (see same-site-redirect.ts),
  // so every redirect below is a relative path, never new URL(path, request.url).
  const url = new URL(request.url)
  const home = redirectToPath('/')

  let wanted = ''
  try {
    wanted = decodeURIComponent(code).trim().toUpperCase()
  } catch {
    return home
  }
  if (!isOrgCode(wanted)) return home

  const auth = await getAuthorizedUser()
  if (!auth.ok) return redirectToPath('/login')
  // Same answer as a code that does not exist: whether an organisation exists
  // is not this person's business either.
  if (!auth.profile.organisations.includes(wanted)) return home

  const response = redirectToPath(safeNextPath(url.searchParams.get('next')))
  response.cookies.set(ACTIVE_ORG_COOKIE, wanted, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: ACTIVE_ORG_COOKIE_MAX_AGE,
  })
  return response
}
