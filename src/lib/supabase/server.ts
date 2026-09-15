import 'server-only'
import { createServerClient as createServerClientSSR } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { agentScopedClient } from '@/lib/supabase/agent-scope'

type CookieStore = Awaited<ReturnType<typeof cookies>>

function cookieClient(cookieStore: CookieStore) {
  return createServerClientSSR(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll()
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            )
          } catch {
            // The `setAll` method was called from a Server Component.
            // This can be ignored if middleware refreshes user sessions.
          }
        },
      },
    }
  )
}

type ServerClient = ReturnType<typeof cookieClient>

// Server client, anon key plus the request's session cookies. Used by every server
// component, layout, and server action for session-scoped, RLS-enforced queries.
export const createServerClient = async (): Promise<ServerClient> => {
  // An agent route (no cookies) runs the quote chain inside runWithAgentClient.
  // Checked BEFORE cookies(): a machine request has no cookie store to read, and
  // a scope without a client throws here rather than falling back to cookies.
  // See lib/supabase/agent-scope.ts.
  const scoped = agentScopedClient()
  if (scoped) return scoped as unknown as ServerClient

  return cookieClient(await cookies())
}
