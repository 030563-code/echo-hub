import 'server-only'
import { AsyncLocalStorage } from 'node:async_hooks'
import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * A request-scoped Supabase client for machine callers that have no cookies.
 *
 * Every server action in the quote chain (createQuote, markQuoteSent,
 * getDealDetails, getProductSkus, assertDealAccess and friends) reaches the
 * database through createServerClient, which reads the session from the
 * request cookies. An agent route such as /api/agent/quote has no cookies, so it
 * mints a session for its own service user and runs the chain inside
 * runWithAgentClient. createServerClient checks this scope FIRST and returns the
 * scoped client without ever touching cookies().
 *
 * Rules that keep this safe inside the Hub's most used auth function:
 *  - als.run only, never enterWith, so a scope ends with its callback and can
 *    never leak into another request on the same worker.
 *  - A scope that is active but holds no client THROWS. It never falls back to
 *    the cookie client, because that would run agent work as whoever happens to
 *    be signed in.
 *  - The store lives on globalThis so a second bundled copy of this module (the
 *    route and the actions can be split into different chunks) still sees the
 *    same scope.
 *
 * Deliberately NOT a 'use server' file: every export of one of those becomes a
 * callable endpoint.
 */

interface AgentScopeStore {
  client: SupabaseClient | null
}

const holder = globalThis as typeof globalThis & {
  __hubAgentSupabase?: AsyncLocalStorage<AgentScopeStore>
}

const als: AsyncLocalStorage<AgentScopeStore> = (holder.__hubAgentSupabase ??=
  new AsyncLocalStorage<AgentScopeStore>())

/** Run fn with `client` as the Supabase client every server action sees. */
export function runWithAgentClient<T>(client: SupabaseClient, fn: () => Promise<T>): Promise<T> {
  return als.run({ client: client ?? null }, fn)
}

/** True while inside runWithAgentClient, whether or not it holds a client. */
export function hasAgentScope(): boolean {
  return als.getStore() !== undefined
}

/**
 * The scoped client, or null outside any scope. Throws when a scope is active
 * without a client, so a broken agent call fails closed instead of falling
 * through to the cookie session.
 */
export function agentScopedClient(): SupabaseClient | null {
  const store = als.getStore()
  if (store === undefined) return null
  if (!store.client) {
    throw new Error('agent scope is active without a Supabase client')
  }
  return store.client
}
