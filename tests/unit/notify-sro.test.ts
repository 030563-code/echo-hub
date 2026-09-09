import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
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

describe('it fires when the order REACHES SRO, not when the leg is created', () => {
  const source = readFileSync(join(process.cwd(), 'src/app/actions/purchase-orders/decide-po.ts'), 'utf8')

  /**
   * Dean, 9 Sep 2026: "It sent me the PO has reached EB SRO email when it is
   * still in the Group approval stage."
   *
   * It did. The send was hung off `next_leg === 'EB_GROUP_TO_SRO'`, which is
   * true when the DEPOT leg is approved and the SRO leg is CREATED. That leg is
   * `requested` at that moment: it sits under Group → S.R.O on the board, the
   * fulfilment card refuses to render, and the link in the email lands on a page
   * that says nothing is waiting.
   *
   * The right moment is one tier later, when that leg is itself approved. The
   * approval RPC says so with `awaiting_fulfilment`, which the deployed function
   * sets true exactly once and only in its EB_GROUP_TO_SRO branch.
   */
  it('is gated on awaiting_fulfilment, the RPC saying a decision is now waiting', () => {
    expect(source).toMatch(/if \(result\.awaiting_fulfilment === true\)[\s\S]{0,1400}notifySroPoReady\(/)
  })

  it('never fires on the leg being created', () => {
    // The exact shape of the bug. `child_id` is the leg that was just made and
    // has not been approved by anybody.
    expect(source).not.toMatch(/next_leg === "EB_GROUP_TO_SRO"[\s\S]{0,600}notifySroPoReady\(/)
    expect(source).not.toMatch(/notifySroPoReady\(\{[\s\S]{0,300}result\.child_id/)
    expect(source).not.toMatch(/notifySroPoReady\(\{[\s\S]{0,300}result\.child_po_number/)
  })

  it('sends the approved leg itself, so the link opens the decision', () => {
    expect(source).toMatch(/notifySroPoReady\(\{[\s\S]{0,200}poId: po\.id/)
    expect(source).toMatch(/notifySroPoReady\(\{[\s\S]{0,200}poNumber: po\.po_number/)
  })

  it('names the depot that started the chain, not EB-GROUP', () => {
    // from_entity on the SRO leg is EB-GROUP, because Group are the ones
    // ordering. The depot is the parent's.
    expect(source).toMatch(/parent\?\.from_entity\) fromDepot = parent\.from_entity/)
    expect(source).toMatch(/fromDepot,/)
  })

  it('lets a mail failure warn, never fail the approval', () => {
    expect(source).toMatch(/if \(!notified\.sent && notified\.reason === "failed"\)[\s\S]{0,200}warning =/)
    expect(source).not.toMatch(/notifySroPoReady[\s\S]{0,500}return \{ success: false/)
  })
})
