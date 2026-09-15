import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/**
 * Jack, the ANZ AI sales agent, may never hold a browser session.
 *
 * The Supabase half of this is the login address having no MX record, so the
 * magic link and password-recovery mail anyone can trigger with the public anon
 * key lands nowhere (jack_cutover.sql). This is the Hub half, and it is the one
 * that still holds if that address is ever changed back by hand: the middleware
 * throws away any session carrying the agent's user id, and /auth/callback
 * undoes the code exchange that produced it.
 */

const JACK_ID = '11111111-2222-4333-8444-555555555555'
const HUMAN_ID = '22222222-3333-4444-8555-666666666666'

// --- middleware collaborators ------------------------------------------------
const middlewareGetUser = vi.fn()
vi.mock('@supabase/ssr', () => ({
  createServerClient: () => ({ auth: { getUser: () => middlewareGetUser() } }),
}))

// --- /auth/callback collaborators -------------------------------------------
const exchangeCodeForSession = vi.fn(async () => ({ error: null }))
const callbackGetUser = vi.fn()
const callbackSignOut = vi.fn(async () => ({ error: null }))
interface ProfileRow {
  pipeline_id: string | null
  display_name: string | null
}
const profileSingle = vi.fn(async (): Promise<{ data: ProfileRow | null }> => ({
  data: { pipeline_id: '14520121', display_name: 'A Rep' },
}))
vi.mock('@/lib/supabase/server', () => ({
  createServerClient: async () => ({
    auth: {
      exchangeCodeForSession: (...a: unknown[]) => exchangeCodeForSession(...(a as [])),
      getUser: () => callbackGetUser(),
      signOut: () => callbackSignOut(),
    },
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: () => profileSingle() }) }) }),
  }),
}))

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { NextRequest } from 'next/server'
import { middleware } from '@/middleware'
import { GET as authCallback } from '@/app/auth/callback/route'
import { agentSenderEmail, agentUserId, isAgentUserId } from '@/lib/agent-account'

const COOKIE = 'sb-korylyniwsqtsvzuzydg-auth-token'

/** The customer-facing Gmail alias: From header, and reply-to on the quote. */
const MAIL_IDENTITY = 'jack.walker@echobarrier.com'
/** The Supabase login, which must never receive mail. See agent-account.ts. */
const LOGIN_IDENTITY = 'jack.agent@no-mail.echobarrier.com'

function request(path: string, withSession = true): NextRequest {
  return new NextRequest(new URL(path, 'https://hub.echobarrier.com'), {
    headers: withSession ? { cookie: `${COOKIE}=eyJhbGciOi.stub; theme=dark` } : {},
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  process.env.JACK_USER_ID = JACK_ID
  middlewareGetUser.mockResolvedValue({ data: { user: { id: HUMAN_ID } } })
  callbackGetUser.mockResolvedValue({ data: { user: { id: HUMAN_ID } } })
})

afterEach(() => {
  delete process.env.JACK_USER_ID
  delete process.env.JACK_SENDER_EMAIL
})

describe('isAgentUserId', () => {
  it('names the agent and nobody else', () => {
    expect(agentUserId()).toBe(JACK_ID)
    expect(isAgentUserId(JACK_ID)).toBe(true)
    expect(isAgentUserId(` ${JACK_ID} `)).toBe(true)
    expect(isAgentUserId(HUMAN_ID)).toBe(false)
    expect(isAgentUserId(null)).toBe(false)
    expect(isAgentUserId(undefined)).toBe(false)
    expect(isAgentUserId('')).toBe(false)
  })

  it('matches nobody when JACK_USER_ID is unset, including a blank id', () => {
    delete process.env.JACK_USER_ID
    expect(isAgentUserId('')).toBe(false)
    expect(isAgentUserId(undefined)).toBe(false)
    expect(isAgentUserId(JACK_ID)).toBe(false)
  })
})

describe('the quote sender address', () => {
  it('is the mail identity for the agent, and untouched for everyone else', () => {
    process.env.JACK_SENDER_EMAIL = MAIL_IDENTITY
    expect(agentSenderEmail(JACK_ID)).toBe('jack.walker@echobarrier.com')
    expect(agentSenderEmail(HUMAN_ID)).toBeNull()
  })

  it('is null rather than the no-mail login address when unset', () => {
    expect(agentSenderEmail(JACK_ID)).toBeNull()
    process.env.JACK_SENDER_EMAIL = '   '
    expect(agentSenderEmail(JACK_ID)).toBeNull()
  })

  // The two addresses are different on purpose: the login one must never be a
  // real mailbox, because a magic link into it is a Jack session.
  it('keeps the mail identity and the login identity apart', () => {
    expect(MAIL_IDENTITY).not.toBe(LOGIN_IDENTITY)
    expect(LOGIN_IDENTITY.endsWith('@no-mail.echobarrier.com')).toBe(true)
    expect(MAIL_IDENTITY.endsWith('@echobarrier.com')).toBe(true)
    expect(MAIL_IDENTITY).not.toContain('no-mail')

    const example = readFileSync(join(process.cwd(), '.env.local.example'), 'utf8')
    expect(example).toContain(`JACK_SENDER_EMAIL=${MAIL_IDENTITY}`)
    expect(example).toContain(`JACK_AUTH_EMAIL=${LOGIN_IDENTITY}`)
  })
})

describe('middleware', () => {
  it('throws away a session held by the agent and clears its Supabase cookies', async () => {
    middlewareGetUser.mockResolvedValue({ data: { user: { id: JACK_ID } } })
    const res = await middleware(request('/deals'))
    expect(res.status).toBe(307)
    expect(res.headers.get('location')).toBe('https://hub.echobarrier.com/login?error=agent_account')
    // Expired with an empty value, so the browser drops it and the next
    // request is an ordinary logged-out one rather than another bounce.
    const setCookie = res.headers.getSetCookie().join('\n')
    expect(setCookie).toContain(`${COOKIE}=;`)
    expect(setCookie).toContain('Expires=Thu, 01 Jan 1970 00:00:00 GMT')
    expect(setCookie).not.toContain('theme=')
  })

  it('refuses the agent on the public paths too, so /login is no way back in', async () => {
    middlewareGetUser.mockResolvedValue({ data: { user: { id: JACK_ID } } })
    for (const path of ['/login', '/onboarding', '/auth/callback', '/api/agent/quote']) {
      const res = await middleware(request(path))
      expect(res.headers.get('location')).toBe('https://hub.echobarrier.com/login?error=agent_account')
    }
  })

  it('lets an ordinary signed-in user through untouched', async () => {
    const res = await middleware(request('/deals'))
    expect(res.status).toBe(200)
    expect(res.headers.get('location')).toBeNull()
  })

  it('still sends a signed-out visitor to the login page', async () => {
    middlewareGetUser.mockResolvedValue({ data: { user: null } })
    const res = await middleware(request('/deals', false))
    expect(res.headers.get('location')).toBe('https://hub.echobarrier.com/login')
  })

  it('does not gate the machine endpoints for a cookieless caller', async () => {
    middlewareGetUser.mockResolvedValue({ data: { user: null } })
    for (const path of ['/api/agent/quote', '/api/mrp/run']) {
      const res = await middleware(request(path, false))
      expect(res.status).toBe(200)
    }
  })
})

describe('/auth/callback', () => {
  const callback = (code = 'abc123') =>
    authCallback(new Request(`https://hub.echobarrier.com/auth/callback?code=${code}`))

  it('signs the agent straight back out instead of landing on the dashboard', async () => {
    callbackGetUser.mockResolvedValue({ data: { user: { id: JACK_ID } } })
    const res = await callback()
    expect(res.headers.get('location')).toBe('https://hub.echobarrier.com/login?error=agent_account')
    expect(callbackSignOut).toHaveBeenCalledTimes(1)
    expect(profileSingle).not.toHaveBeenCalled()
  })

  it('still lets a real user in', async () => {
    const res = await callback()
    expect(res.headers.get('location')).toBe('https://hub.echobarrier.com/')
    expect(callbackSignOut).not.toHaveBeenCalled()
  })

  it('still sends a user with no profile name to onboarding', async () => {
    profileSingle.mockResolvedValue({ data: { pipeline_id: null, display_name: null } })
    const res = await callback()
    expect(res.headers.get('location')).toBe('https://hub.echobarrier.com/onboarding')
  })
})

describe('createQuote never prints the login address on a quote', () => {
  // The other half of the same finding, and the half that reaches a customer.
  // createQuote copies the sender email onto the HubSpot quote, so after the
  // cutover user.email would tell customers to reply to an address with no MX
  // record. A source check because there is no unit test around createQuote
  // itself: it is a 'use server' action wired to HubSpot and Supabase end to
  // end, and this is the one line that must not come back.
  const src = readFileSync(join(process.cwd(), 'src/app/actions/sales/create-quote.ts'), 'utf8')

  it('resolves the sender through agentSenderEmail and sends that, not user.email', () => {
    expect(src).toContain("import { agentSenderEmail } from '@/lib/agent-account'")
    expect(src).toContain('const senderEmail = agentSenderEmail(user.id) ?? user.email ?? null')
    expect(src).toContain('email: senderEmail,')
    expect(src).not.toContain('email: user.email')
    expect(src).not.toContain("createdByLabel: user.email")
  })
})
