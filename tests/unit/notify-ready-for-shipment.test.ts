import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  notifyReadyForShipment,
  buildReadyNotifyPayload,
  readyNotifyRecipients,
} from '@/app/actions/purchase-orders/notify-ready-for-shipment'
import { buildCargoDraft, type CargoDraft } from '@/lib/cargo-request'
import { resolveRecipients } from '@/lib/email-recipients'

/**
 * The email that says an order is finished and ready for shipment.
 *
 * It exists because the approval step made finishing silent. It goes to US, not
 * to the forwarder: it asks somebody to open the shipment request and release
 * it. Juraj in production, the test address while the switch is on.
 */

const KEYS = [
  'N8N_CARGO_NOTIFY_WEBHOOK_URL',
  'N8N_CARGO_NOTIFY_WEBHOOK_SECRET',
  'READY_NOTIFY_TO',
  'READY_NOTIFY_CC',
  'HUB_EMAIL_TEST_RECIPIENT',
  'NEXT_PUBLIC_HUB_ENV',
  'NEXT_PUBLIC_HUB_BASE_URL',
] as const

const ORIGINAL = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]))

const META = {
  poId: '11111111-2222-3333-4444-555555555555',
  poNumber: 'EBSRO2026001-01',
  masterRef: 'MR-PO-01163',
}

const draft = (overrides: Partial<CargoDraft> = {}): CargoDraft => ({
  ...buildCargoDraft({
    poNumber: META.poNumber,
    finishedAt: '2026-09-30T14:05:00.000Z',
    lines: [
      { sku: 'EBH9NA', product_name: 'Echo Barrier H9', product_family: 'H9', quantity: 140 },
      { sku: 'EBH10NA', product_name: 'Echo Barrier H10', product_family: 'H10', quantity: 71 },
    ],
    consignee: { depot: 'US-BAL', address: '8125 Stayton Drive, Jessup, MD 20794' },
    to: '',
    cc: 'juraj@echobarrier.eu',
  }),
  ...overrides,
})

function lastBody(): Record<string, unknown> {
  const mock = fetch as unknown as ReturnType<typeof vi.fn>
  return JSON.parse(String(mock.mock.calls[0][1].body))
}

beforeEach(() => {
  for (const key of KEYS) delete process.env[key]
  process.env.N8N_CARGO_NOTIFY_WEBHOOK_URL = 'https://n8n.example/webhook/cargo-notify'
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

describe('who hears that an order is ready', () => {
  it('is Juraj by default, with no configuration at all', async () => {
    expect(readyNotifyRecipients()).toEqual({ to: 'juraj@echobarrier.eu', cc: '' })
    await notifyReadyForShipment(META, draft())
    expect(lastBody().to).toEqual(['juraj@echobarrier.eu'])
  })

  it('can be pointed somewhere else without a deploy', () => {
    process.env.READY_NOTIFY_TO = 'ops@echobarrier.eu'
    process.env.READY_NOTIFY_CC = 'dave.lindsay@echobarrier.com'
    expect(readyNotifyRecipients()).toEqual({
      to: 'ops@echobarrier.eu',
      cc: 'dave.lindsay@echobarrier.com',
    })
  })

  it('is the test address while the switch is on, and Juraj is not copied in', async () => {
    process.env.HUB_EMAIL_TEST_RECIPIENT = 'tester@example.com'
    await notifyReadyForShipment(META, draft())
    const body = lastBody()
    expect(body.to).toEqual(['tester@example.com'])
    expect(body.cc).toEqual([])
    expect(body.is_test).toBe(true)
    expect(JSON.stringify([body.to, body.cc, body.bcc])).not.toContain('juraj')
    expect((body.intended as { to: string[] }).to).toEqual(['juraj@echobarrier.eu'])
  })
})

describe('what it says', () => {
  it('carries the order, the pallets and the link to the waiting request', async () => {
    process.env.NEXT_PUBLIC_HUB_BASE_URL = 'https://hub.echobarrier.com'
    await notifyReadyForShipment(META, draft())
    const body = lastBody()

    expect(body.action).toBe('manufacturing_ready_for_shipment')
    expect(body.po_number).toBe('EBSRO2026001-01')
    expect(body.master_ref).toBe('MR-PO-01163')

    const s = body.shipment as Record<string, unknown>
    expect(s.cargo_readiness_date).toBe('2026-09-30')
    expect(s.pieces).toBe(4)
    expect(s.description).toBe('Acoustic Barriers H10, H9')
    expect(s.delivery_term).toBeNull()

    expect(body.link).toBe(
      'https://hub.echobarrier.com/purchase-orders/11111111-2222-3333-4444-555555555555',
    )
  })

  it('agrees with the approval screen, because it is built from the same draft', () => {
    const d = draft({ pieces: 9, description: 'Acoustic Barriers H9 only', delivery_term: 'DAP' })
    const payload = buildReadyNotifyPayload(META, d, resolveRecipients({ to: 'a@x.com' }))
    const s = payload.shipment
    expect(s.pieces).toBe(9)
    expect(s.description).toBe('Acoustic Barriers H9 only')
    expect(s.delivery_term).toBe('DAP')
  })

  it('is not the forwarder email: it never names Cargo Partner as a recipient', async () => {
    process.env.READY_NOTIFY_TO = 'juraj@echobarrier.eu'
    await notifyReadyForShipment(META, draft({ to: 'bookings@forwarder.example' }))
    const body = lastBody()
    expect(JSON.stringify([body.to, body.cc, body.bcc])).not.toContain('forwarder')
  })

  it('sends the secret header when one is configured', async () => {
    process.env.N8N_CARGO_NOTIFY_WEBHOOK_SECRET = 'shhh'
    await notifyReadyForShipment(META, draft())
    const mock = fetch as unknown as ReturnType<typeof vi.fn>
    expect(mock.mock.calls[0][1].headers['x-hub-secret']).toBe('shhh')
  })
})

describe('when it must not send', () => {
  it('sends nothing at all in the staging sandbox', async () => {
    process.env.NEXT_PUBLIC_HUB_ENV = 'staging'
    expect(await notifyReadyForShipment(META, draft())).toEqual({ sent: false, reason: 'staging' })
    expect(fetch as unknown as ReturnType<typeof vi.fn>).not.toHaveBeenCalled()
  })

  it('says so rather than throwing when no webhook is configured', async () => {
    delete process.env.N8N_CARGO_NOTIFY_WEBHOOK_URL
    expect(await notifyReadyForShipment(META, draft())).toEqual({
      sent: false,
      reason: 'not_configured',
    })
  })

  it('reports a failure rather than throwing when the webhook refuses', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('nope', { status: 500 })))
    expect(await notifyReadyForShipment(META, draft())).toEqual({ sent: false, reason: 'failed' })
  })
})
