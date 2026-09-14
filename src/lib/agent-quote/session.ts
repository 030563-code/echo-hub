import 'server-only'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { createAdminClient } from '@/lib/supabase/admin'

/**
 * A short-lived Supabase session for Jack, minted per request with no password.
 *
 * Jack's auth user (JACK_AUTH_EMAIL, id JACK_USER_ID) has a random password
 * nobody knows, so /login cannot be used with it. Two things have to be true
 * for that to mean anything, because a password is not the only way in:
 *  - JACK_AUTH_EMAIL is the LOGIN identity and it must be an address that
 *    receives no mail (jack.agent@no-mail.echobarrier.com: no MX, no A record,
 *    no wildcard). Anyone can ask Supabase for a magic link or a password reset
 *    for a known address using the public anon key, so a deliverable one hands
 *    a full Jack session to whoever can read that mailbox. It is NOT the same
 *    as jack.walker@echobarrier.com, which is the MAIL identity: the Gmail
 *    alias in the From header and on the quote. The two must never be swapped,
 *    in either direction.
 *  - the Hub refuses a browser session for this user id outright. See
 *    isAgentUserId in lib/agent-account.ts, the middleware gate and the auth
 *    callback: even a valid Jack session cookie is thrown away at the door.
 *
 * The route mints its own session with the service role instead:
 *  1. auth.admin.getUserById(JACK_USER_ID) and check its email. generateLink
 *     with type 'magiclink' CREATES the user when the address is unknown, so a
 *     mistyped JACK_AUTH_EMAIL must be refused before that call, not after.
 *  2. auth.admin.generateLink({ type: 'magiclink', email }). This returns the
 *     link properties (including hashed_token) and sends no email; Supabase
 *     documents it as generating links "to be sent via a custom email provider".
 *  3. verifyOtp({ token_hash, type: 'magiclink' }) on a fresh anon client with
 *     persistSession and autoRefreshToken off, so the session lives only in this
 *     client object for this request.
 *  4. getUser() must return JACK_USER_ID.
 *
 * The caller MUST call signOut() in a finally block. It uses scope 'local', which
 * revokes this session only; 'global' would end a concurrent Jack request.
 *
 * CONCURRENCY. GoTrue keeps ONE outstanding one-time token per user, so a
 * second generateLink for Jack replaces the first. Two calls arriving together
 * therefore raced: the later link overwrote the earlier hash and the earlier
 * request's verifyOtp failed with a token that no longer existed, turning a
 * perfectly good quote request into a 500. Two things stop it now:
 *  - inside one process, the link-and-verify pair runs in a queue, one mint at
 *    a time, so the common case (two calls landing on the same instance) never
 *    races at all;
 *  - across processes, which a queue cannot reach, a lost token is retried up
 *    to MINT_ATTEMPTS times with a short random wait, so the loser of a race
 *    asks for its own fresh link instead of failing the request.
 * Only the verify step retries. A bad config, an unknown user or a link issued
 * for somebody else are all wrong in a way a second attempt cannot fix.
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

export interface JackSession {
  client: SupabaseClient
  userId: string
  signOut: () => Promise<void>
}

/** How many links one mint may burn before it gives up. */
const MINT_ATTEMPTS = 3

/** Longest wait before re-issuing a link, in ms. Randomised so two processes
 *  that collided do not collide again in step. */
const MINT_RETRY_MS = 40

/**
 * One mint at a time in this process.
 *
 * Every mint joins the tail of the chain and the tail moves on whether it
 * settled or threw, so one failure cannot wedge the queue. It is a
 * process-local lock and nothing more: a second Netlify instance has its own
 * chain, which is what the retry above is for.
 */
let mintQueue: Promise<unknown> = Promise.resolve()

function queued<T>(work: () => Promise<T>): Promise<T> {
  const run = mintQueue.then(work, work)
  mintQueue = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

export async function mintJackClient(): Promise<JackSession> {
  const email = String(process.env.JACK_AUTH_EMAIL ?? '').trim().toLowerCase()
  const expectedId = String(process.env.JACK_USER_ID ?? '').trim()
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!email || !expectedId || !url || !anonKey) throw new AgentSessionError('config')

  const admin = createAdminClient()

  const { data: existing, error: lookupError } = await admin.auth.admin.getUserById(expectedId)
  if (lookupError || !existing?.user || String(existing.user.email ?? '').toLowerCase() !== email) {
    throw new AgentSessionError('lookup')
  }

  // Only from here on does one mint interfere with another: the link this asks
  // for is the only one Jack has until it is spent.
  return queued(async () => {
    for (let attempt = 1; attempt <= MINT_ATTEMPTS; attempt++) {
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
      // No session back means the token was gone, which is what losing the
      // race looks like: another generateLink replaced ours. Ask for our own.
      if (verifyError || !verified?.session) {
        await signOut()
        if (attempt < MINT_ATTEMPTS) {
          await new Promise((resolve) => setTimeout(resolve, Math.random() * MINT_RETRY_MS))
          continue
        }
        throw new AgentSessionError('verify')
      }
      // A session for somebody else is not a race, and a second link would not
      // change it. Refuse at once.
      if (verified.user?.id !== expectedId) {
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
    // Unreachable: the loop either returns or throws on its last attempt.
    throw new AgentSessionError('verify')
  })
}
