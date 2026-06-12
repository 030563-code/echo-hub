import 'server-only'
import { createServerClient as createServerClientSSR } from '@supabase/ssr'
import { cookies } from 'next/headers'

// Server client — anon key + the request's session cookies. Used by every server
// component, layout, and server action for session-scoped, RLS-enforced queries.
export const createServerClient = async () => {
  const cookieStore = await cookies()

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
