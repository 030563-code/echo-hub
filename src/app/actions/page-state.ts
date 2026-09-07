'use server'

/**
 * Read, write and clear one person's saved state for one page.
 *
 * EVERY export of a 'use server' file is a callable endpoint, so each one here
 * authenticates first and derives the user id from the SESSION, never from an
 * argument. There is deliberately no capability check beyond being logged in:
 * a row is a person's own half-finished cart or their own search box, it is
 * readable and writable by nobody else, and gating it on a module capability
 * would only mean a rep who loses `pricing.view` also loses their own typing.
 *
 * The writes go through the session client so the "hub: own page state" RLS
 * policy is the enforcer, the same doctrine create-po.ts follows. The admin
 * client is never used here and must not be: there is no privileged read of
 * anyone else's state anywhere in the Hub.
 *
 * Restoring saved state can never widen what a user may do. It only refills
 * boxes; every submit path re-authorises and re-prices server-side exactly as
 * it did before, so a draft built while someone held a capability they have
 * since lost is refused on submit like any other request.
 */

import { createServerClient } from '@/lib/supabase/server'
import { isPageKey, pageStateBytes, PAGE_STATE_MAX_BYTES, type StoredPageState } from '@/lib/page-state'

export type LoadPageStateResult =
  | { ok: true; state: StoredPageState | null }
  | { ok: false; error: string }

export type WritePageStateResult = { ok: true; updatedAt: string } | { ok: false; error: string }

const BAD_KEY = 'That page key is not a valid one.'
const NO_SESSION = 'Not signed in.'

/** The current user's id, or null. Deliberately lighter than getAuthorizedUser:
 *  this feature needs identity, not the profile or the capability set. */
async function sessionUserId(): Promise<{ id: string; supabase: Awaited<ReturnType<typeof createServerClient>> } | null> {
  const supabase = await createServerClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  return user ? { id: user.id, supabase } : null
}

export async function loadPageState(pageKey: string): Promise<LoadPageStateResult> {
  if (!isPageKey(pageKey)) return { ok: false, error: BAD_KEY }
  const session = await sessionUserId()
  if (!session) return { ok: false, error: NO_SESSION }

  const { data, error } = await session.supabase
    .from('user_page_state')
    .select('state, base, updated_at')
    .eq('user_id', session.id)
    .eq('page_key', pageKey)
    .maybeSingle()

  // A failed read must not break the page it belongs to: the caller falls back
  // to a blank form, which is exactly today's behaviour.
  if (error) return { ok: false, error: 'Could not read your saved state.' }
  if (!data) return { ok: true, state: null }

  return {
    ok: true,
    state: { data: data.state, base: data.base ?? null, updatedAt: data.updated_at },
  }
}

export async function savePageState(
  pageKey: string,
  data: unknown,
  base?: string | null,
): Promise<WritePageStateResult> {
  if (!isPageKey(pageKey)) return { ok: false, error: BAD_KEY }
  const session = await sessionUserId()
  if (!session) return { ok: false, error: NO_SESSION }

  // Refused here with a readable message rather than letting the CHECK
  // constraint reject it as a database error the user cannot act on.
  if (pageStateBytes(data) > PAGE_STATE_MAX_BYTES) {
    return { ok: false, error: 'This page holds too much to save. Your work is still on screen.' }
  }

  const updatedAt = new Date().toISOString()
  const { error } = await session.supabase.from('user_page_state').upsert(
    {
      user_id: session.id,
      page_key: pageKey,
      state: data as never,
      base: base ?? null,
      // Set here rather than by a trigger: public.set_updated_at() exists in
      // the live database but is declared in no migration in this repo, so
      // depending on it would bind this table to undeclared schema.
      updated_at: updatedAt,
    },
    { onConflict: 'user_id,page_key' },
  )

  if (error) return { ok: false, error: 'Could not save your progress.' }
  return { ok: true, updatedAt }
}

export async function clearPageState(pageKey: string): Promise<{ ok: boolean }> {
  if (!isPageKey(pageKey)) return { ok: false }
  const session = await sessionUserId()
  if (!session) return { ok: false }

  const { error } = await session.supabase
    .from('user_page_state')
    .delete()
    .eq('user_id', session.id)
    .eq('page_key', pageKey)

  return { ok: !error }
}
