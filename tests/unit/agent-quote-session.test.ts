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
