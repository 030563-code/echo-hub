import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { notifySroPoReady, buildSroNotifyPayload } from '@/app/actions/purchase-orders/notify-sro'
import { resolveRecipients } from '@/lib/email-recipients'

/**
 * The email telling Juraj an order has reached SRO.
 *
 * The assertion that matters is not the wording, which n8n owns, but that the
 * Hub decides the addresses and that the test switch is honoured on the way
 * out. A workflow holding its own copy of Juraj's address would mail him while
 * the Hub believed everything was going to Dean.
 */

const KEYS = [
  'N8N_SRO_NOTIFY_WEBHOOK_URL',
  'N8N_SRO_NOTIFY_WEBHOOK_SECRET',
  'SRO_NOTIFY_TO',
  'SRO_NOTIFY_CC',
  'HUB_EMAIL_TEST_RECIPIENT',
  'NEXT_PUBLIC_HUB_ENV',
  'NEXT_PUBLIC_HUB_BASE_URL',
] as const

const ORIGINAL = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]))

const INPUT = {
  poId: '11111111-2222-3333-4444-555555555555',
  poNumber: 'EBG26099',
  masterRef: 'EBUS2026001',
  fromDepot: 'US-BAL',
  approvedBy: 'Dave Lindsay',
  lines: [{ sku: 'EBH9NA', product_name: 'H9 Barrier', quantity: 96 }],
}

function lastBody(): Record<string, unknown> {
  const mock = fetch as unknown as ReturnType<typeof vi.fn>
  return JSON.parse(String(mock.mock.calls[0][1].body))
}

beforeEach(() => {
  for (const key of KEYS) delete process.env[key]
  process.env.N8N_SRO_NOTIFY_WEBHOOK_URL = 'https://n8n.example/webhook/sro-notify'
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 200 })))
})

afterEach(() => {
  for (const key of KEYS) {
    const value = ORIGINAL[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('notifySroPoReady, when it may send', () => {
  it('posts to the configured webhook and reports the send', async () => {
    const result = await notifySroPoReady(INPUT)
    expect(result.sent).toBe(true)
    expect(fetch as unknown as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(1)
  })

  it('defaults to Juraj when no recipient is configured', async () => {
    await notifySroPoReady(INPUT)
    expect(lastBody().to).toEqual(['juraj@echobarrier.eu'])
  })

  it('lets configuration change the audience without a deploy', async () => {
    process.env.SRO_NOTIFY_TO = 'ops@echobarrier.eu'
    process.env.SRO_NOTIFY_CC = 'dave.lindsay@echobarrier.com'
    await notifySroPoReady(INPUT)
    const body = lastBody()
    expect(body.to).toEqual(['ops@echobarrier.eu'])
    expect(body.cc).toEqual(['dave.lindsay@echobarrier.com'])
  })

  it('sends the secret header when one is configured', async () => {
    process.env.N8N_SRO_NOTIFY_WEBHOOK_SECRET = 'shhh'
    await notifySroPoReady(INPUT)
    const mock = fetch as unknown as ReturnType<typeof vi.fn>
    expect(mock.mock.calls[0][1].headers['x-hub-secret']).toBe('shhh')
  })

  it('carries the PO, the lines and a link into the fulfilment step', async () => {
    await notifySroPoReady(INPUT)
    const body = lastBody()
    expect(body.action).toBe('sro_po_ready')
    expect(body.po_number).toBe('EBG26099')
    expect(body.master_ref).toBe('EBUS2026001')
    expect(body.from_depot).toBe('US-BAL')
    expect(body.link).toBe(
      'https://hub.echobarrier.com/purchase-orders/11111111-2222-3333-4444-555555555555',
    )
    expect(body.lines).toEqual([{ sku: 'EBH9NA', product_name: 'H9 Barrier', quantity: 96 }])
  })
})

describe('notifySroPoReady honours the test switch', () => {
  it('reaches only the test address, with Juraj nowhere in the send', async () => {
    process.env.HUB_EMAIL_TEST_RECIPIENT = 'tester@example.com'
    process.env.SRO_NOTIFY_CC = 'dave.lindsay@echobarrier.com'
    await notifySroPoReady(INPUT)

    const body = lastBody()
    expect(body.to).toEqual(['tester@example.com'])
    expect(body.cc).toEqual([])
    expect(body.bcc).toEqual([])
    expect(body.is_test).toBe(true)

    const outgoing = JSON.stringify([body.to, body.cc, body.bcc]).toLowerCase()
    expect(outgoing).not.toContain('juraj@echobarrier.eu')
    expect(outgoing).not.toContain('dave.lindsay@echobarrier.com')
  })

  it('still tells n8n who it would have gone to, so a test send is verifiable', async () => {
    process.env.HUB_EMAIL_TEST_RECIPIENT = 'tester@example.com'
    await notifySroPoReady(INPUT)
    expect((lastBody().intended as { to: string[] }).to).toEqual(['juraj@echobarrier.eu'])
  })
})

describe('notifySroPoReady, when it must not send', () => {
  it('sends nothing at all in the staging sandbox', async () => {
    process.env.NEXT_PUBLIC_HUB_ENV = 'staging'
    const result = await notifySroPoReady(INPUT)
    expect(result).toEqual({ sent: false, reason: 'staging' })
    expect(fetch as unknown as ReturnType<typeof vi.fn>).not.toHaveBeenCalled()
  })

  it('says so rather than throwing when no webhook is configured', async () => {
    delete process.env.N8N_SRO_NOTIFY_WEBHOOK_URL
    const result = await notifySroPoReady(INPUT)
    expect(result).toEqual({ sent: false, reason: 'not_configured' })
    expect(fetch as unknown as ReturnType<typeof vi.fn>).not.toHaveBeenCalled()
  })

  it('reports a failure rather than throwing when the webhook refuses', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('nope', { status: 500 })))
    expect(await notifySroPoReady(INPUT)).toEqual({ sent: false, reason: 'failed' })
  })

  it('reports a failure rather than throwing when n8n cannot be reached', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')))
    expect(await notifySroPoReady(INPUT)).toEqual({ sent: false, reason: 'failed' })
  })
})

describe('buildSroNotifyPayload', () => {
  it('uses the configured base url for the link', () => {
    process.env.NEXT_PUBLIC_HUB_BASE_URL = 'http://localhost:3000/'
    const payload = buildSroNotifyPayload(INPUT, resolveRecipients({ to: 'a@x.com' }))
    expect(payload.link).toBe(
      'http://localhost:3000/purchase-orders/11111111-2222-3333-4444-555555555555',
    )
  })
})
