import { redirect } from 'next/navigation'
import { readPageState } from '@/lib/page-state-server'
import {
  QUOTES_FILTERS_KEY,
  RESTORABLE_QUOTE_PARAMS,
  parseQuotesFilters,
  pickRestorableParams,
} from '@/lib/page-drafts'

export const dynamic = 'force-dynamic'

/**
 * The Quotes index lands on the board, carrying whatever filters this user was
 * last looking at. The sidebar points here, so this is the "arrival" the
 * restore is for; a link to /quotes/board itself is left exactly as written.
 *
 * This is the ONLY redirect in the module, and one click may only change the
 * url once. Two earlier shapes both crashed Next's client router with
 * "Rendered more hooks than during the previous render", which surfaces as the
 * browser's "This page couldn't load" screen:
 *
 *   - a second redirect() inside /quotes/board, so /quotes hopped twice, and
 *   - a router.replace() from the tab bar, fired the moment this redirect
 *     landed, so the url changed again while the router was still settling.
 *
 * Folding the filters into this one existing hop avoids both.
 */
export default async function QuotesIndex() {
  const stored = await readPageState(QUOTES_FILTERS_KEY)
  const query = pickRestorableParams(parseQuotesFilters(stored?.data), RESTORABLE_QUOTE_PARAMS)
  redirect(query ? `/quotes/board?${query}` : '/quotes/board')
}
