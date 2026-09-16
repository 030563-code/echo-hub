import { NextResponse } from 'next/server'
import { safeNextPath } from '@/lib/active-organisation'
import {
  FACTORY_LOCALE_COOKIE,
  FACTORY_LOCALE_COOKIE_MAX_AGE,
  isFactoryLocale,
} from '@/lib/factory/strings'

/**
 * Switch the manufacturer's language: GET /factory-lang/en?next=/factory
 *
 * The same shape as /org/[code]: the tab bar's two links are plain anchors
 * here, the handler sets a cookie and sends the browser on to `next`, which is
 * only ever a path on this site. A full navigation rather than a client
 * transition, because every string on the page is rendered on the server.
 *
 * A GET that sets a cookie is fine here because of what the cookie is: a
 * display preference. It gates nothing, it widens nothing, and an unknown value
 * falls back to Slovak, so there is nothing for a planted one to reach.
 */
export const dynamic = 'force-dynamic'

export async function GET(request: Request, context: { params: Promise<{ locale: string }> }) {
  const { locale } = await context.params
  const url = new URL(request.url)
  const next = safeNextPath(url.searchParams.get('next'))
  const response = NextResponse.redirect(new URL(next, request.url))

  let wanted = ''
  try {
    wanted = decodeURIComponent(locale).trim().toLowerCase()
  } catch {
    return response
  }
  // An unrecognised language changes nothing and still lands on the page.
  if (!isFactoryLocale(wanted)) return response

  response.cookies.set(FACTORY_LOCALE_COOKIE, wanted, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: FACTORY_LOCALE_COOKIE_MAX_AGE,
  })
  return response
}
