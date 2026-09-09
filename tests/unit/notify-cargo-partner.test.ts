import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  notifyCargoPartnerReady,
  buildCargoNotifyPayload,
  palletsFor,
  cargoDescription,
} from '@/app/actions/purchase-orders/notify-cargo-partner'
import { resolveRecipients } from '@/lib/email-recipients'

/**
 * The email telling Cargo Partner a container is ready to collect.
 *
 * Two things are worth pinning here. The Hub decides the addresses, so the test
 * switch cannot be bypassed by a workflow holding its own copy of a forwarder's
 * inbox. And the body carries the shipping details a forwarder needs to open an
 * order, with the one detail nobody has answered left explicitly null rather
 * than invented.
 */

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }),
    }),
  }),
}))

const KEYS = [
  'N8N_CARGO_NOTIFY_WEBHOOK_URL',
  'N8N_CARGO_NOTIFY_WEBHOOK_SECRET',
  'CARGO_NOTIFY_TO',
  'CARGO_NOTIFY_CC',
  'HUB_EMAIL_TEST_RECIPIENT',
  'NEXT_PUBLIC_HUB_ENV',
  'NEXT_PUBLIC_HUB_BASE_URL',
] as const

const ORIGINAL = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]))

const INPUT = {
  poId: '11111111-2222-3333-4444-555555555555',
  poNumber: 'EBSRO2026001-01',
  masterRef: 'MR-PO-01163',
  finishedAt: '2026-09-30T14:05:00.000Z',
  lines: [
    { sku: 'EBH9NA', product_name: 'Echo Barrier H9', product_family: 'H9', quantity: 140 },
    { sku: 'EBH10NA', product_name: 'Echo Barrier H10', product_family: 'H10', quantity: 71 },
  ],
}

function lastBody(): Record<string, unknown> {
  const mock = fetch as unknown as ReturnType<typeof vi.fn>
  return JSON.parse(String(mock.mock.calls[0][1].body))
}

beforeEach(() => {
  for (const key of KEYS) delete process.env[key]
  process.env.N8N_CARGO_NOTIFY_WEBHOOK_URL = 'https://n8n.example/webhook/cargo-notify'
  process.env.CARGO_NOTIFY_TO = 'bookings@forwarder.example'
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

describe('pallets', () => {
  it('rounds up per line, because a part pallet still takes a pallet', () => {
    expect(palletsFor(INPUT.lines)).toBe(4) // 140/70 = 2, then 71/70 rounds to 2
  })
  it('ignores lines with no quantity', () => {
    expect(palletsFor([{ sku: 'X', product_name: null, product_family: null, quantity: null }])).toBe(0)
  })
})

describe('cargo description', () => {
  it('names the models it is carrying', () => {
    expect(cargoDescription(INPUT.lines)).toBe('Acoustic Barriers H10, H9')
  })
  it('falls back when no family is recorded', () => {
    expect(cargoDescription([{ sku: 'X', product_name: null, product_family: null, quantity: 1 }])).toBe(
      'Acoustic Barriers',
    )
  })
})

describe('notifyCargoPartnerReady, when it may send', () => {
  it('posts to the configured webhook and reports the send', async () => {
    const result = await notifyCargoPartnerReady(INPUT)
    expect(result.sent).toBe(true)
    expect(fetch as unknown as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(1)
  })

  it('copies Juraj by default, because he is the one taken out of the loop', async () => {
    await notifyCargoPartnerReady(INPUT)
    expect(lastBody().cc).toEqual(['juraj@echobarrier.eu'])
  })

  it('sends the secret header when one is configured', async () => {
    process.env.N8N_CARGO_NOTIFY_WEBHOOK_SECRET = 'shhh'
    await notifyCargoPartnerReady(INPUT)
    const mock = fetch as unknown as ReturnType<typeof vi.fn>
    expect(mock.mock.calls[0][1].headers['x-hub-secret']).toBe('shhh')
  })

  it('carries the shipping details a forwarder needs to open an order', async () => {
    await notifyCargoPartnerReady(INPUT)
    const body = lastBody()
    expect(body.action).toBe('cargo_collection_ready')

    const s = body.shipment as Record<string, unknown>
    expect(s.general_reference).toBe('EBSRO2026001-01')
    expect(s.main_modality).toBe('SEA')
    expect(s.main_category).toBe('FCL')
    expect(s.business_direction).toBe('EXPORT')
    expect(s.cargo_readiness_date).toBe('2026-09-30')
    expect(s.pieces).toBe(4)
    expect(s.package_type_code).toBe('PAL')
    expect(s.description).toBe('Acoustic Barriers H10, H9')

    const p = body.participants as Record<string, { account?: string; name?: string }>
    expect(p.shipper.account).toBe('446813')
    expect(p.principal.account).toBe('446813')
    expect(p.pickup.account).toBe('604070')
    expect(p.pickup.name).toBe('BAMIDA, s.r.o.')
    expect(p.office_in_charge.account).toBe('139461')
  })

  it('leaves the Incoterm null rather than inventing who pays for freight', async () => {
    await notifyCargoPartnerReady(INPUT)
    expect((lastBody().shipment as { delivery_term: unknown }).delivery_term).toBeNull()
  })

  it('breaks the pallet count down per line', async () => {
    await notifyCargoPartnerReady(INPUT)
    const lines = lastBody().lines as Array<{ sku: string; pallets: number }>
    expect(lines).toEqual([
      expect.objectContaining({ sku: 'EBH9NA', pallets: 2 }),
      expect.objectContaining({ sku: 'EBH10NA', pallets: 2 }),
    ])
  })
})

describe('notifyCargoPartnerReady honours the test switch', () => {
  it('reaches only the test address, with the forwarder nowhere in the send', async () => {
    process.env.HUB_EMAIL_TEST_RECIPIENT = 'tester@example.com'
    await notifyCargoPartnerReady(INPUT)

    const body = lastBody()
    expect(body.to).toEqual(['tester@example.com'])
    expect(body.cc).toEqual([])
    expect(body.bcc).toEqual([])
    expect(body.is_test).toBe(true)

    const outgoing = JSON.stringify([body.to, body.cc, body.bcc]).toLowerCase()
    expect(outgoing).not.toContain('bookings@forwarder.example')
    expect(outgoing).not.toContain('juraj@echobarrier.eu')
  })

  it('still says who it would have gone to, so a test send is verifiable', async () => {
    process.env.HUB_EMAIL_TEST_RECIPIENT = 'tester@example.com'
    await notifyCargoPartnerReady(INPUT)
    const intended = lastBody().intended as { to: string[]; cc: string[] }
    expect(intended.to).toEqual(['bookings@forwarder.example'])
    expect(intended.cc).toEqual(['juraj@echobarrier.eu'])
  })
})

describe('notifyCargoPartnerReady, when it must not send', () => {
  it('sends nothing at all in the staging sandbox', async () => {
    process.env.NEXT_PUBLIC_HUB_ENV = 'staging'
    expect(await notifyCargoPartnerReady(INPUT)).toEqual({ sent: false, reason: 'staging' })
    expect(fetch as unknown as ReturnType<typeof vi.fn>).not.toHaveBeenCalled()
  })

  it('says so rather than throwing when no webhook is configured', async () => {
    delete process.env.N8N_CARGO_NOTIFY_WEBHOOK_URL
    expect(await notifyCargoPartnerReady(INPUT)).toEqual({ sent: false, reason: 'not_configured' })
    expect(fetch as unknown as ReturnType<typeof vi.fn>).not.toHaveBeenCalled()
  })

  it('refuses to guess a forwarder inbox when none is configured', async () => {
    delete process.env.CARGO_NOTIFY_TO
    expect(await notifyCargoPartnerReady(INPUT)).toEqual({ sent: false, reason: 'not_configured' })
    expect(fetch as unknown as ReturnType<typeof vi.fn>).not.toHaveBeenCalled()
  })

  it('reports a failure rather than throwing when the webhook refuses', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('nope', { status: 500 })))
    expect(await notifyCargoPartnerReady(INPUT)).toEqual({ sent: false, reason: 'failed' })
  })
})

describe('buildCargoNotifyPayload', () => {
  it('names the destination depot when the chain resolves one', () => {
    const payload = buildCargoNotifyPayload(INPUT, resolveRecipients({ to: 'a@x.com' }), {
      depot: 'US-BAL',
      address: '8125 Stayton Drive, Jessup, MD 20794',
    })
    const consignee = (payload.participants as { consignee: { depot: string; address: string } }).consignee
    expect(consignee.depot).toBe('US-BAL')
    expect(consignee.address).toContain('Jessup')
  })

  it('uses the configured base url for the link', () => {
    process.env.NEXT_PUBLIC_HUB_BASE_URL = 'http://localhost:3000/'
    const payload = buildCargoNotifyPayload(INPUT, resolveRecipients({ to: 'a@x.com' }), {
      depot: null,
      address: null,
    })
    expect(payload.link).toBe(
      'http://localhost:3000/purchase-orders/11111111-2222-3333-4444-555555555555',
    )
  })
})
