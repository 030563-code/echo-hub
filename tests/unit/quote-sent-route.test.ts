import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * POST /api/quotes/detect-sent: who may call it, what it accepts, and that it is wired the way
 * n8n calls it. HubSpot and the database are faked; nothing here reaches either.
 */

const SECRET = 'c'.repeat(64)
const revalidated: unknown[][] = []

vi.mock('next/cache', () => ({ revalidatePath: (...args: unknown[]) => void revalidated.push(args) }))
vi.mock('@/lib/quote-sent/store.server', () => ({
  supabaseQuoteSentStore: () => ({
    lastCleanMoveRunEnd: async () => null,
    startRun: async () => 1,
    record: async () => {},
    finishRun: async () => {},
  }),
}))
vi.mock('@/lib/quote-sent/hubspot.server', () => ({
  hubspotQuoteSentPort: {
    pipelines: async () => [],
    outgoingEmailIds: async () => [],
    dealIdsForEmails: async () => new Map(),
    readDeals: async () => [],
    quotesForDeals: async () => new Map(),
    readEmails: async () => [],
    userEmails: async () => new Set(),
    readDeal: async () => null,
    moveDeal: async () => {
      throw new Error('must not move in this test')
    },
  },
}))

const { POST } = await import('@/app/api/quotes/detect-sent/route')

const call = (body?: unknown, auth: string | null = `Bearer ${SECRET}`) =>
  POST(
    new Request('http://localhost/api/quotes/detect-sent', {
      method: 'POST',
      headers: auth ? { authorization: auth } : {},
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    }),
  )

describe('POST /api/quotes/detect-sent', () => {
  const saved = process.env.MRP_CRON_SECRET
  beforeEach(() => {
    process.env.MRP_CRON_SECRET = SECRET
    revalidated.length = 0
  })
  afterEach(() => {
    process.env.MRP_CRON_SECRET = saved
  })

  it('refuses a caller without the secret, and everyone when the secret is unset', async () => {
    expect((await call(undefined, null)).status).toBe(401)
    expect((await call(undefined, 'Bearer wrong')).status).toBe(401)
    delete process.env.MRP_CRON_SECRET
    expect((await call(undefined, 'Bearer ')).status).toBe(401)
    expect((await call(undefined, `Bearer ${SECRET}`)).status).toBe(401)
  })

  it('runs the schedule with no body at all', async () => {
    const res = await call()
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ mode: 'move', emailsRead: 0, moved: [] })
  })

  it('reads a report window of up to 7 days, and moves nothing', async () => {
    const res = await call({ mode: 'report', from: '2026-09-20T00:00:00Z', to: '2026-09-24T00:00:00Z' })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ mode: 'report', windowFrom: '2026-09-20T00:00:00.000Z' })
    expect(revalidated).toEqual([])
  })

  it('refuses a move run that names its own window, which could open a gap in the chain', async () => {
    expect((await call({ mode: 'move', from: '2026-09-20T00:00:00Z' })).status).toBe(400)
  })

  it('refuses a window longer than 7 days, backwards, or anything unexpected', async () => {
    expect((await call({ mode: 'report', from: '2026-09-01T00:00:00Z', to: '2026-09-24T00:00:00Z' })).status).toBe(400)
    expect((await call({ mode: 'report', from: '2026-09-24T00:00:00Z', to: '2026-09-20T00:00:00Z' })).status).toBe(400)
    expect((await call({ mode: 'backfill', from: '2026-09-20T00:00:00Z' })).status).toBe(400)
    expect((await call({ mode: 'report', dealId: '123' })).status).toBe(400)
    expect((await call('not json')).status).toBe(400)
  })
})

describe('wiring', () => {
  const read = (f: string) => readFileSync(join(process.cwd(), f), 'utf8')

  it('is on the middleware list of machine routes, so n8n is not sent to the login page', () => {
    expect(read('src/middleware.ts')).toMatch(/SELF_AUTHENTICATED_PATHS = \[[^\]]*'\/api\/quotes\/detect-sent'/)
  })

  it('writes to HubSpot only through hubspotFetch, so the staging switch holds', () => {
    const port = read('src/lib/quote-sent/hubspot.server.ts')
    expect(port).not.toMatch(/\bfetch\(/)
    expect(port).toMatch(/method: 'PATCH',\s*body: JSON\.stringify\(\{ properties: \{ dealstage: stageId \} \}\)/)
  })

  it('Mark as sent and the check share one stage rule', () => {
    expect(read('src/app/actions/sales/mark-quote-sent.ts')).toContain("from '@/lib/quote-sent/stage'")
  })
})
