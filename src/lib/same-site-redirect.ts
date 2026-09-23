import { NextResponse } from 'next/server'
import { safeNextPath } from '@/lib/active-organisation'

/** 307 keeps the method (the default for a GET handler); 303 turns a POST into a GET. */
export type SameSiteRedirectStatus = 303 | 307

/**
 * A redirect to a path on this site, sent as a RELATIVE Location header.
 *
 * 🔴 Never build a redirect target from request.url in a route handler. On Netlify, request.url
 * inside a route handler is at times the deploy's own address (`<deploy id>--hub-echo.netlify.app`)
 * rather than hub.echobarrier.com. An absolute redirect built from it moves the browser to that
 * host, where the session cookie does not exist, so the person lands on a login page exactly as
 * if they had been signed out. Seen on the live site on 23 Sep 2026: the first organisation switch
 * after signing in went to `6ab3a0b771289d0008d30a7d--hub-echo.netlify.app/login`, the next three
 * stayed on hub.echobarrier.com. That is the "we keep getting logged out sometimes" Dean reported.
 *
 * A relative Location is resolved by the browser against the address it actually requested, so it
 * cannot change host, and it behaves identically on localhost, a deploy preview and production.
 *
 * The path goes through safeNextPath, so nothing but a path on this site is ever sent: a full URL
 * or a protocol-relative `//host` collapses to the dashboard.
 */
export function redirectToPath(path: string, status: SameSiteRedirectStatus = 307): NextResponse {
  return new NextResponse(null, { status, headers: { Location: safeNextPath(path) } })
}
