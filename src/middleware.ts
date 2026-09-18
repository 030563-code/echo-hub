import { createServerClient } from '@supabase/ssr'
import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { isAgentUserId } from '@/lib/agent-account'

// Public paths that an unauthenticated user may reach. Everything else under the
// matcher requires a session. This is the SESSION gate only — capability
// (module-level) enforcement happens in each (dashboard) page via
// requireCapability(), and RLS enforces row access server-side.
// There is no /manufacturing exemption any more. It held the supplier's signed
// link, which existed because the factory had no Hub account. They have one now
// (Dean, 16 Sep 2026), so the orders, the document, the dates and the finished
// button all sit behind /factory with a real session, and there is one door
// with one set of rules instead of two.
// /offline.html is the card the service worker shows when the network is gone.
// It is a static file with no data on it, and the worker precaches it at
// install time, which for most people happens on the login page: gated, it
// would be fetched as a redirect and the login page would end up cached under
// that name. Listed here rather than adding "html" to the matcher's extension
// allowlist, so exactly one path is exempt instead of a shape of path.
const PUBLIC_PATHS = ['/login', '/onboarding', '/auth/callback', '/offline.html']

// Machine endpoints that carry their OWN authentication and must never be
// session-gated: a cookieless caller (n8n cron) would otherwise be 307'd to
// /login, and — because a redirect chain ends in a 200 HTML page — the caller
// would record the failure as success. Kept as an exact-match allowlist rather
// than a blanket "/api" so a future API route cannot silently lose the session
// gate by inheriting an exemption it never asked for. Each entry MUST enforce
// its own auth, constant-time and fail-closed:
//  - /api/mrp/run: Bearer MRP_CRON_SECRET (n8n cron).
//  - /api/agent/quote: Bearer AGENT_QUOTE_SECRET or AGENT_QUOTE_SECRET_PREVIOUS
//    (Jack's Quote Sender in n8n), then a conversation binding check.
const SELF_AUTHENTICATED_PATHS = ['/api/mrp/run', '/api/mrp/factory-alert', '/api/agent/quote', '/api/calls/ingest']

function isPublic(pathname: string): boolean {
  return (
    SELF_AUTHENTICATED_PATHS.includes(pathname) ||
    PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`))
  )
}

export async function middleware(req: NextRequest) {
  let res = NextResponse.next({ request: { headers: req.headers } })

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return req.cookies.getAll()
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => req.cookies.set(name, value))
          res = NextResponse.next({ request: { headers: req.headers } })
          cookiesToSet.forEach(({ name, value, options }) =>
            res.cookies.set(name, value, options)
          )
        },
      },
    }
  )

  const {
    data: { user },
  } = await supabase.auth.getUser()

  // Preserve the refreshed Supabase session cookies on any redirect, else dropped.
  const redirectWithCookies = (url: string) => {
    const redirect = NextResponse.redirect(new URL(url, req.url))
    res.cookies.getAll().forEach((c) => redirect.cookies.set(c))
    return redirect
  }

  if (!user && !isPublic(req.nextUrl.pathname)) {
    return redirectWithCookies('/login')
  }

  // Jack, the ANZ AI sales agent, is a machine identity and may NEVER hold a
  // browser session. His quote route mints its own session in process, with no
  // cookies, so nothing legitimate lands here; a cookie for this user id means
  // somebody signed in as the agent. Supabase leaves magic-link and
  // password-recovery sign-in open for every email user and the public anon key
  // is enough to ask for either, so "no password is stored" is not on its own a
  // lock. Throw the session away rather than redirect with it: the cookies are
  // cleared on the way out, so the next request is an ordinary logged-out one.
  if (isAgentUserId(user?.id)) {
    const redirect = NextResponse.redirect(new URL('/login?error=agent_account', req.url))
    for (const cookie of req.cookies.getAll()) {
      if (cookie.name.startsWith('sb-')) redirect.cookies.delete(cookie.name)
    }
    return redirect
  }

  return res
}

export const config = {
  matcher: [
    // Run on everything EXCEPT Next internals, the favicon, and static ASSET
    // FILES matched by extension. An explicit extension allowlist (not a blanket
    // "any dotted path") means a route slug containing a "." still gets the
    // session gate — closes the latent matcher-bypass (review APP-4) while still
    // letting /logo.jpg etc. through (the static-asset 307 fix).
    '/((?!_next/static|_next/image|favicon\\.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|avif|ico|css|js|map|woff2?|ttf|otf|txt|xml|json|webmanifest)$).*)',
  ],
}
