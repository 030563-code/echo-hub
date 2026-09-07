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
