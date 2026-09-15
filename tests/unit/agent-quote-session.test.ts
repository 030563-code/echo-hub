import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * mintJackClient: passwordless session for the Jack service user.
 * The live round trip is proven against Supabase separately; this pins the
 * order of calls and every refusal, with the SDK mocked.
 */

const JACK_ID = '11111111-2222-4333-8444-555555555555'

const getUserById = vi.fn()
const generateLink = vi.fn()
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({ auth: { admin: { getUserById, generateLink } } }),
}))

const verifyOtp = vi.fn()
const getUser = vi.fn()
const signOut = vi.fn(async () => ({ error: null }))
const createClient = vi.fn(() => ({ auth: { verifyOtp, getUser, signOut } }))
vi.mock('@supabase/supabase-js', () => ({ createClient: (...a: unknown[]) => createClient(...(a as [])) }))

import { mintJackClient } from '@/lib/agent-quote/session'

beforeEach(() => {
  vi.clearAllMocks()
  process.env.JACK_AUTH_EMAIL = 'jack.agent@no-mail.echobarrier.com'
  process.env.JACK_USER_ID = JACK_ID
  getUserById.mockResolvedValue({ data: { user: { id: JACK_ID, email: 'jack.agent@no-mail.echobarrier.com' } }, error: null })
  generateLink.mockResolvedValue({ data: { properties: { hashed_token: 'hash123' }, user: { id: JACK_ID } }, error: null })
  verifyOtp.mockResolvedValue({ data: { session: { access_token: 'x' }, user: { id: JACK_ID } }, error: null })
  getUser.mockResolvedValue({ data: { user: { id: JACK_ID } }, error: null })
})

describe('mintJackClient', () => {
  it('looks the user up, generates a magic link, verifies its hash on a non-persisting client', async () => {
    const session = await mintJackClient()
    expect(session.userId).toBe(JACK_ID)
    expect(getUserById).toHaveBeenCalledWith(JACK_ID)
    expect(generateLink).toHaveBeenCalledWith({ type: 'magiclink', email: 'jack.agent@no-mail.echobarrier.com' })
    const options = (createClient.mock.calls[0] as unknown[])[2] as { auth: Record<string, boolean> }
    expect(options.auth).toMatchObject({ persistSession: false, autoRefreshToken: false })
    expect(verifyOtp).toHaveBeenCalledWith({ token_hash: 'hash123', type: 'magiclink' })
    await session.signOut()
    expect(signOut).toHaveBeenCalledWith({ scope: 'local' })
  })

  it('refuses before generateLink when the configured email is not the user\'s (generateLink would create a user)', async () => {
    process.env.JACK_AUTH_EMAIL = 'jack.agent@no-mail.echobarrier.co'
    await expect(mintJackClient()).rejects.toMatchObject({ step: 'lookup' })
    expect(generateLink).not.toHaveBeenCalled()
  })

  it('refuses when unconfigured', async () => {
    delete process.env.JACK_USER_ID
    await expect(mintJackClient()).rejects.toMatchObject({ step: 'config' })
    expect(getUserById).not.toHaveBeenCalled()
  })

  it('refuses a link issued for another user', async () => {
    generateLink.mockResolvedValue({ data: { properties: { hashed_token: 'h' }, user: { id: 'someone-else' } }, error: null })
    await expect(mintJackClient()).rejects.toMatchObject({ step: 'link' })
    expect(verifyOtp).not.toHaveBeenCalled()
  })

  /**
   * GoTrue holds ONE outstanding one-time token per user, so a second
   * generateLink replaces the first and the first hash stops verifying. This
   * is that behaviour, and it is what the race actually looked like.
   */
  function singleLiveToken() {
    let live: string | null = null
    let issued = 0
    generateLink.mockImplementation(async () => {
      live = `hash${++issued}`
      return { data: { properties: { hashed_token: live }, user: { id: JACK_ID } }, error: null }
    })
    verifyOtp.mockImplementation(async ({ token_hash }: { token_hash: string }) => {
      if (token_hash !== live) {
        return { data: { session: null, user: null }, error: { message: 'Token has expired or is invalid' } }
      }
      live = null // spent: one-time means one time
      return { data: { session: { access_token: token_hash }, user: { id: JACK_ID } }, error: null }
    })
    return { steal: () => { live = 'someone-elses-token' } }
  }

  it('two simultaneous mints both get a session, because they do not share a token', async () => {
    singleLiveToken()
    const [a, b] = await Promise.all([mintJackClient(), mintJackClient()])
    expect(a.userId).toBe(JACK_ID)
    expect(b.userId).toBe(JACK_ID)
    // One link each, spent in turn. Before the queue the second generateLink
    // landed while the first was still holding its hash, and the first mint
    // died at 'verify'.
    expect(generateLink).toHaveBeenCalledTimes(2)
    expect(verifyOtp).toHaveBeenCalledTimes(2)
  })

  it('ten at once all succeed', async () => {
    singleLiveToken()
    const sessions = await Promise.all(Array.from({ length: 10 }, () => mintJackClient()))
    expect(sessions.map((s) => s.userId)).toEqual(Array(10).fill(JACK_ID))
    expect(verifyOtp).toHaveBeenCalledTimes(10)
  })

  it('asks for a fresh link when something outside this process took the token', async () => {
    // The queue only covers one Node process. A second Netlify instance minting
    // at the same moment is the case the retry is for.
    const gotrue = singleLiveToken()
    const verify = verifyOtp.getMockImplementation()!
    let first = true
    verifyOtp.mockImplementation(async (args: { token_hash: string }) => {
      if (first) {
        first = false
        gotrue.steal()
      }
      return verify(args)
    })
    const session = await mintJackClient()
    expect(session.userId).toBe(JACK_ID)
    expect(generateLink).toHaveBeenCalledTimes(2)
    expect(signOut).toHaveBeenCalledWith({ scope: 'local' })
  })

  it('gives up after three links rather than retrying for ever', async () => {
    singleLiveToken()
    verifyOtp.mockResolvedValue({ data: { session: null, user: null }, error: { message: 'Token has expired or is invalid' } })
    await expect(mintJackClient()).rejects.toMatchObject({ step: 'verify' })
    expect(generateLink).toHaveBeenCalledTimes(3)
  })

  it('a failed mint does not wedge the next one', async () => {
    singleLiveToken()
    verifyOtp.mockResolvedValueOnce({ data: { session: null, user: null }, error: { message: 'no' } })
    generateLink.mockRejectedValueOnce(new Error('network'))
    await expect(mintJackClient()).rejects.toThrow()
    singleLiveToken()
    await expect(mintJackClient()).resolves.toMatchObject({ userId: JACK_ID })
  })

  it('signs out and refuses when the verified or current user is not Jack', async () => {
    verifyOtp.mockResolvedValue({ data: { session: { access_token: 'x' }, user: { id: 'other' } }, error: null })
    await expect(mintJackClient()).rejects.toMatchObject({ step: 'verify' })
    expect(signOut).toHaveBeenCalledWith({ scope: 'local' })

    signOut.mockClear()
    verifyOtp.mockResolvedValue({ data: { session: { access_token: 'x' }, user: { id: JACK_ID } }, error: null })
    getUser.mockResolvedValue({ data: { user: { id: 'other' } }, error: null })
    await expect(mintJackClient()).rejects.toMatchObject({ step: 'identity' })
    expect(signOut).toHaveBeenCalledWith({ scope: 'local' })
  })
})
