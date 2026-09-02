import { redirect } from 'next/navigation'

/**
 * The queue moved to /quotes/deals. This stub keeps old links and bookmarks
 * working.
 *
 * A redirect() page rather than a next.config.ts rule, matching the idiom
 * already used at quotes/page.tsx, and because a `permanent: true` config
 * redirect is cached by the browser indefinitely: reverting the rename would
 * strand anyone who had visited once.
 *
 * No capability gate here on purpose. The target enforces it, and gating twice
 * would send an unauthorised visitor to /login from a URL that is only a
 * signpost.
 */
export default function LegacyQuoteRequestsRedirect() {
  redirect('/quotes/deals')
}
