import 'server-only'
import { createClient } from '@supabase/supabase-js'

// Admin client — service-role key, bypasses RLS. ONLY for server-side privileged
// operations after a server-side capability check (e.g. an admin granting
// capabilities, onboarding writes to isolation columns). The `server-only` import
// guarantees this can never be bundled to the browser. Never expose the key.
export const createAdminClient = () => {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    }
  )
}
