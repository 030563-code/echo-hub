import { createBrowserClient } from '@supabase/ssr'

// Browser client — uses the anon/publishable key ONLY. Every read/write through
// this client is constrained by RLS. The service-role key must never be used here.
export const createClient = () => {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  )
}
