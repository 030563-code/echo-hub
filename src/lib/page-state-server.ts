import 'server-only'

/**
 * The server's own half of page state.
 *
 * Two jobs the browser hook cannot do:
 *  - a server component that wants to LABEL something (the deal page says
 *    "Resume quote draft" rather than "New quote" when a draft exists),
 *  - a completed action that must clear a draft authoritatively, so a browser
 *    closed mid-publish cannot leave behind a resume that no longer applies.
 *
 * Neither takes a Supabase client. They used to, and the call sites are exactly
 * the files where the WRONG client is closest to hand: create-quote.ts imports
 * both `createServerClient` and `createAdminClient`, and the admin client
 * bypasses RLS, so a one-word slip would turn an owner-only read into a read of
 * anybody's state. Making the client here removes the choice, and the explicit
 * user_id filter means RLS is defence in depth rather than the only control.
 */

import { createServerClient } from '@/lib/supabase/server'
import { isPageKey, type StoredPageState } from '@/lib/page-state'
import {
  QUOTES_FILTERS_KEY,
  RESTORABLE_QUOTE_PARAMS,
  hasAnyRestorableParam,
  parseQuotesFilters,
} from '@/lib/page-drafts'

export async function readPageState(pageKey: string): Promise<StoredPageState | null> {
  if (!isPageKey(pageKey)) return null
  const supabase = await createServerClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return null

  const { data, error } = await supabase
    .from('user_page_state')
    .select('state, base, updated_at')
    .eq('user_id', user.id)
    .eq('page_key', pageKey)
    .maybeSingle()
  if (error || !data) return null
  return { data: data.state, base: data.base ?? null, updatedAt: data.updated_at }
}

/**
 * Clear a draft because the work it belonged to is done.
 *
 * Best effort by design: the quote is already published and the deal already
 * written by the time this runs, so a failure here must never turn a successful
 * submit into an error. The worst case is a stale draft the user can dismiss
 * with Start again.
 */
export async function deletePageState(pageKey: string): Promise<void> {
  if (!isPageKey(pageKey)) return
  try {
    const supabase = await createServerClient()
    const {
      data: { user },
    } = await supabase.auth.getUser()
    if (!user) return
    await supabase.from('user_page_state').delete().eq('user_id', user.id).eq('page_key', pageKey)
  } catch {
    // deliberately swallowed, see above
  }
}


/**
 * Put back the filters this user last chose, WITHOUT touching the url.
 *
 * Every url-changing version of this crashed Next's client Router with
 * "Rendered more hooks than during the previous render", which the browser
 * shows as "This page couldn't load. Reload to try again, or go back.":
 * a second redirect() on the board, a router.replace() from the tab bar, and
 * folding the filters into the /quotes redirect (which, because it has to
 * await this read first, turns into an in-stream client redirect that never
 * lands). One click may change the url once, and /quotes -> /quotes/board is
 * already that one change.
 *
 * So the page keeps its bare url and simply reads with the remembered filters.
 * The filter bar is seeded from the same values, so what is on screen always
 * matches what was fetched, and the moment anything is changed the bar's own
 * GET form puts it in the url again.
 *
 * A url carrying any recognised parameter is a deliberate request (a shared
 * link, a bookmark, Clear, a filter just applied) and is returned untouched.
 */
export async function withStoredQuotesFilters(
  params: Record<string, string | string[] | undefined>,
): Promise<Record<string, string | string[] | undefined>> {
  if (hasAnyRestorableParam(params, RESTORABLE_QUOTE_PARAMS)) return params

  const stored = parseQuotesFilters((await readPageState(QUOTES_FILTERS_KEY))?.data)
  if (!stored) return params

  const merged = { ...params }
  for (const name of RESTORABLE_QUOTE_PARAMS) {
    const value = stored.params[name]
    if (value !== undefined) merged[name] = value
  }
  return merged
}
