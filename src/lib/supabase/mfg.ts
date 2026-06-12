import 'server-only'
import { createClient } from '@supabase/supabase-js'

// Read-only client for the SEPARATE manufacturing Supabase project
// (cdkpczinzhykcdbfoobn — bom_weekly_snapshot, landed_weekly_snapshot, fx_weekly).
// That project has RLS enabled with zero policies (service-role-only by design),
// so BOM reads run with the mfg service-role key — SERVER-SIDE ONLY. The
// `server-only` import guarantees it can never be bundled to the browser, and the
// Hub only ever READS from it (the mfg pipelines own the writes via n8n).
export const createMfgClient = () => {
  return createClient(
    process.env.MFG_SUPABASE_URL!,
    process.env.MFG_SUPABASE_SERVICE_ROLE_KEY!,
    {
      auth: { autoRefreshToken: false, persistSession: false },
    }
  )
}
