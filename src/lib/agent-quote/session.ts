import 'server-only'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { createAdminClient } from '@/lib/supabase/admin'

/**
 * A short-lived Supabase session for Bruce, minted per request with no password.
 *
 * Bruce's auth user (BRUCE_AUTH_EMAIL, id BRUCE_USER_ID) has a random password
 * nobody knows, so /login cannot be used with it. The route mints a session
 * with the service role instead:
 *  1. auth.admin.getUserById(BRUCE_USER_ID) and check its email. generateLink
 *     with type 'magiclink' CREATES the user when the address is unknown, so a
 *     mistyped BRUCE_AUTH_EMAIL must be refused before that call, not after.
 *  2. auth.admin.generateLink({ type: 'magiclink', email }). This returns the
 *     link properties (including hashed_token) and sends no email; Supabase
 *     documents it as generating links "to be sent via a custom email provider".
 *  3. verifyOtp({ token_hash, type: 'magiclink' }) on a fresh anon client with
 *     persistSession and autoRefreshToken off, so the session lives only in this
 *     client object for this request.
 *  4. getUser() must return BRUCE_USER_ID.
 *
 * The caller MUST call signOut() in a finally block. It uses scope 'local', which
 * revokes this session only; 'global' would end a concurrent Bruce request.
 *
 * Checked against @supabase/auth-js 2.108.1: GenerateLinkProperties.hashed_token,
 * VerifyTokenHashParams { token_hash, type: EmailOtpType } where EmailOtpType
 * includes 'magiclink', and SignOut { scope: 'global' | 'local' | 'others' }.
 */

export class AgentSessionError extends Error {
  constructor(public readonly step: 'config' | 'lookup' | 'link' | 'verify' | 'identity') {
    super(`agent session failed at ${step}`)
    this.name = 'AgentSessionError'
  }
}

export interface BruceSession {
  client: SupabaseClient
  userId: string
  signOut: () => Promise<void>
}

export async function mintBruceClient(): Promise<BruceSession> {
  const email = String(process.env.BRUCE_AUTH_EMAIL ?? '').trim().toLowerCase()
  const expectedId = String(process.env.BRUCE_USER_ID ?? '').trim()
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!email || !expectedId || !url || !anonKey) throw new AgentSessionError('config')

  const admin = createAdminClient()

  const { data: existing, error: lookupError } = await admin.auth.admin.getUserById(expectedId)
  if (lookupError || !existing?.user || String(existing.user.email ?? '').toLowerCase() !== email) {
    throw new AgentSessionError('lookup')
  }

  const { data: link, error: linkError } = await admin.auth.admin.generateLink({ type: 'magiclink', email })
  const tokenHash = link?.properties?.hashed_token
  if (linkError || !tokenHash || link?.user?.id !== expectedId) {
    throw new AgentSessionError('link')
  }

  const client = createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  })

  const signOut = async () => {
    try {
      await client.auth.signOut({ scope: 'local' })
    } catch {
      // Best effort. The access token expires on its own; nothing to report.
    }
  }

  const { data: verified, error: verifyError } = await client.auth.verifyOtp({
    token_hash: tokenHash,
    type: 'magiclink',
  })
  if (verifyError || !verified?.session || verified.user?.id !== expectedId) {
    await signOut()
    throw new AgentSessionError('verify')
  }

  const { data: me, error: meError } = await client.auth.getUser()
  if (meError || me?.user?.id !== expectedId) {
    await signOut()
    throw new AgentSessionError('identity')
  }

  return { client, userId: expectedId, signOut }
}
