import { createServerClient } from '@supabase/ssr'
import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

// Public paths that an unauthenticated user may reach. Everything else under the
// matcher requires a session. This is the SESSION gate only — capability
// (module-level) enforcement happens in each (dashboard) page via
// requireCapability(), and RLS enforces row access server-side.
const PUBLIC_PATHS = ['/login', '/onboarding', '/auth/callback']

function isPublic(pathname: string): boolean {
  return PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`))
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

  return res
}

export const config = {
  matcher: [
    // Run on everything EXCEPT Next internals, the favicon, and static asset
    // files (any path containing a "." — e.g. /logo.jpg). Without the dotted-path
    // exclusion the session gate 307-redirects public assets and breaks <Image>.
    '/((?!_next/static|_next/image|favicon.ico|.*\\..*).*)',
  ],
}
