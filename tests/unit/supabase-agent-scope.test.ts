import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * The agent seam inside createServerClient.
 *
 * createServerClient backs every RLS check in the Hub, so the seam has to be
 * provably inert for normal requests and provably cookie-free for agent ones:
 *  - outside a scope, the cookie client is built exactly as before;
 *  - inside runWithAgentClient, the scoped client comes back and cookies() is
 *    never called at all (a machine request has no cookie store);
 *  - a scope with no client throws instead of falling back to cookies, which
 *    would run agent work as whoever is signed in.
 */

const cookiesMock = vi.fn(async () => ({ getAll: () => [], set: () => {} }))
vi.mock('next/headers', () => ({ cookies: () => cookiesMock() }))

const ssrClient = { kind: 'cookie-client' }
const ssrFactory = vi.fn(() => ssrClient)
vi.mock('@supabase/ssr', () => ({ createServerClient: (...args: unknown[]) => ssrFactory(...(args as [])) }))

import { createServerClient } from '@/lib/supabase/server'
import { runWithAgentClient, hasAgentScope, agentScopedClient } from '@/lib/supabase/agent-scope'

const agentClient = { kind: 'agent-client' } as unknown as SupabaseClient

beforeEach(() => {
  cookiesMock.mockClear()
  ssrFactory.mockClear()
})

describe('createServerClient agent seam', () => {
  it('returns the cookie client outside any scope', async () => {
    expect(hasAgentScope()).toBe(false)
    expect(agentScopedClient()).toBeNull()
    const client = await createServerClient()
    expect(client).toBe(ssrClient)
    expect(cookiesMock).toHaveBeenCalledTimes(1)
    expect(ssrFactory).toHaveBeenCalledTimes(1)
  })

  it('returns the scoped client inside runWithAgentClient without calling cookies()', async () => {
    const seen = await runWithAgentClient(agentClient, async () => {
      expect(hasAgentScope()).toBe(true)
      // Twice, across an await, the way the quote chain calls it.
      const first = await createServerClient()
      await new Promise((r) => setTimeout(r, 1))
      const second = await createServerClient()
      return [first, second]
    })
    expect(seen[0]).toBe(agentClient)
    expect(seen[1]).toBe(agentClient)
    expect(cookiesMock).not.toHaveBeenCalled()
    expect(ssrFactory).not.toHaveBeenCalled()
  })

  it('ends the scope with the callback, so the next call is a cookie call again', async () => {
    await runWithAgentClient(agentClient, async () => createServerClient())
    expect(hasAgentScope()).toBe(false)
    expect(await createServerClient()).toBe(ssrClient)
    expect(cookiesMock).toHaveBeenCalledTimes(1)
  })

  it('does not leak a scope into a concurrent request', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => (release = r))
    const agent = runWithAgentClient(agentClient, async () => {
      await gate
      return createServerClient()
    })
    // A normal request interleaved while the agent scope is suspended.
    const normal = await createServerClient()
    release()
    expect(normal).toBe(ssrClient)
    expect(await agent).toBe(agentClient)
  })

  it('throws when a scope is active without a client, and never reads cookies', async () => {
    await expect(
      runWithAgentClient(null as unknown as SupabaseClient, async () => createServerClient()),
    ).rejects.toThrow(/without a Supabase client/)
    expect(cookiesMock).not.toHaveBeenCalled()
    expect(ssrFactory).not.toHaveBeenCalled()
  })

  it('keeps one store on globalThis, so a second module copy sees the same scope', async () => {
    const holder = globalThis as { __hubAgentSupabase?: unknown }
    expect(holder.__hubAgentSupabase).toBeDefined()
    await runWithAgentClient(agentClient, async () => {
      vi.resetModules()
      const fresh = await import('@/lib/supabase/agent-scope')
      expect(fresh.agentScopedClient()).toBe(agentClient)
    })
  })
})
