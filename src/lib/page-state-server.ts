import 'server-only'

/**
 * The server's own half of page state.
 *
 * Two jobs the browser hook cannot do:
 *  - a server component that wants to LABEL something (the deal page says
 *    "Resume quote draft" rather than "New quote" when a draft exists),
 *  - a completed action that must clear a draft authoritatively, so a browser
 *    that was closed mid-publish cannot leave behind a resume that no longer
 *    applies.
 *
 * Both take the caller's own session client, so the same owner-only RLS policy
 * applies as everywhere else. There is no privileged path to another user's
 * state and there must not be one.
 */

import { isPageKey, type StoredPageState } from '@/lib/page-state'
import type { createServerClient } from '@/lib/supabase/server'

/** The caller's own session client, so owner-only RLS is the enforcer. */
type Client = Awaited<ReturnType<typeof createServerClient>>

export async function readPageState(
  supabase: Client,
  pageKey: string,
): Promise<StoredPageState | null> {
  if (!isPageKey(pageKey)) return null
  const { data, error } = await supabase
    .from('user_page_state')
    .select('state, base, updated_at')
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
export async function deletePageState(supabase: Client, pageKey: string): Promise<void> {
  if (!isPageKey(pageKey)) return
  try {
    await supabase.from('user_page_state').delete().eq('page_key', pageKey)
  } catch {
    // deliberately swallowed, see above
  }
}
