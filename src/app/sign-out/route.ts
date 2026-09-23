import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase/server'
import { redirectToPath } from '@/lib/same-site-redirect'

/**
 * Sign out: POST /sign-out
 *
 * A ROUTE, not a Server Action, since 16 Sep 2026. Dean: "when I press sign out
 * it goes to the This page couldnt load page on the prod version."
 *
 * Reproduced: a tab loaded before a deploy sends a Server Action id that the new
 * build does not contain, the server answers 404 with "Server Action ... was not
 * found on the server", and the page dies. Action ids are content-hashed per
 * build; a URL is not. Six deploys went out that afternoon, and sign out is
 * exactly the button somebody presses on a tab that has been open all day, so it
 * is the one control that must not depend on which build rendered the page.
 *
 * It is also a plain form target, so it works before React has hydrated and with
 * no JavaScript at all.
 *
 * POST only. A GET would be followed by a link prefetch, a crawler or an image
 * loader, and sign people out for looking at a page.
 */

export const dynamic = 'force-dynamic'

/**
 * Only accept a submit that came from our own pages.
 *
 * Being signed out by a hostile page is a nuisance rather than a breach, but it
 * costs two headers to refuse. Sec-Fetch-Site is the precise answer and every
 * current browser sends it; the Origin against Host check covers anything that
 * does not.
 */
function sameOrigin(request: Request): boolean {
  const site = request.headers.get('sec-fetch-site')
  if (site && site !== 'same-origin' && site !== 'none') return false

  const origin = request.headers.get('origin')
  const host = request.headers.get('host')
  if (origin && host) {
    try {
      if (new URL(origin).host !== host) return false
    } catch {
      return false
    }
  }
  return true
}

export async function POST(request: Request) {
  if (!sameOrigin(request)) {
    return new NextResponse('Forbidden', { status: 403 })
  }

  const supabase = await createServerClient()
  await supabase.auth.signOut()

  // 303: the browser follows it with a GET, so the login page is not a resubmit
  // of this POST and Back does not offer to send it again. Relative, because
  // request.url can carry the Netlify deploy's own host (same-site-redirect.ts).
  return redirectToPath('/login', 303)
}
