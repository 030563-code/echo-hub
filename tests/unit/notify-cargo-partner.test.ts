import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  notifyCargoPartnerReady,
  buildCargoNotifyPayload,
  defaultCargoRecipients,
} from '@/app/actions/purchase-orders/notify-cargo-partner'
import { buildCargoDraft, palletsFor, cargoDescription, type CargoDraft } from '@/lib/cargo-request'
import { resolveRecipients } from '@/lib/email-recipients'

/**
 * The email telling Cargo Partner a container is ready to collect.
 *
 * Three things are worth pinning. The Hub decides the addresses, so the test
 * switch cannot be bypassed by a stored one. The body carries the shipping
 * details a forwarder needs to open an order. And the one detail nobody has
 * answered, the Incoterm, stays explicitly null rather than being invented.
 */

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

const META = {
  poId: '11111111-2222-3333-4444-555555555555',
  poNumber: 'EBSRO2026001-01',
  masterRef: 'MR-PO-01163',
}

const LINES = [
  { product_name: 'Echo Barrier H9', product_family: 'H9', quantity: 140 },
  { product_name: 'Echo Barrier H10', product_family: 'H10', quantity: 71 },
]

function draft(overrides: Partial<CargoDraft> = {}): CargoDraft {
  return {
    ...buildCargoDraft({
      poNumber: META.poNumber,
      finishedAt: '2026-09-30T14:05:00.000Z',
      lines: LINES,
      consignee: { depot: 'US Baltimore', address: '8125 Stayton Drive, Jessup, MD 20794' },
      to: 'bookings@forwarder.example',
      cc: 'juraj@echobarrier.eu',
    }),
    ...overrides,
  }
}

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

describe('pallets and description', () => {
  it('rounds up per line, because a part pallet still takes a pallet', () => {
    expect(palletsFor(LINES)).toBe(4) // 140/70 = 2, then 71/70 rounds to 2
  })
  it('ignores lines with no quantity', () => {
    expect(palletsFor([{ product_name: null, product_family: null, quantity: null }])).toBe(0)
  })
  it('names the models it is carrying', () => {
    expect(cargoDescription(LINES)).toBe('Acoustic Barriers H10, H9')
  })
  it('falls back when no family is recorded', () => {
    expect(cargoDescription([{ product_name: null, product_family: null, quantity: 1 }])).toBe(
      'Acoustic Barriers',
    )
  })
})

describe('the draft a person is asked to approve', () => {
  it('starts from the order and leaves the Incoterm unanswered', () => {
    const d = draft()
    expect(d.general_reference).toBe('EBSRO2026001-01')
    expect(d.cargo_readiness_date).toBe('2026-09-30')
    expect(d.pieces).toBe(4)
    expect(d.package_type_code).toBe('PAL')
    expect(d.description).toBe('Acoustic Barriers H10, H9')
    expect(d.delivery_term).toBeNull()
    expect(d.consignee_name).toBe('US Baltimore')
    expect(d.lines.map((l) => l.pallets)).toEqual([2, 2])
  })

  it('never guesses a forwarder inbox, and always copies Juraj', () => {
    expect(defaultCargoRecipients()).toEqual({ to: '', cc: 'juraj@echobarrier.eu' })
    process.env.CARGO_NOTIFY_TO = 'bookings@forwarder.example'
    process.env.CARGO_NOTIFY_CC = 'someone@echobarrier.eu'
    expect(defaultCargoRecipients()).toEqual({
      to: 'bookings@forwarder.example',
      cc: 'someone@echobarrier.eu',
    })
  })
})

describe('notifyCargoPartnerReady, when it may send', () => {
  it('posts to the configured webhook and reports the send', async () => {
    const result = await notifyCargoPartnerReady(META, draft())
    expect(result.sent).toBe(true)
    expect(fetch as unknown as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(1)
  })

  it('copies whoever the approved request names', async () => {
    await notifyCargoPartnerReady(META, draft())
    expect(lastBody().cc).toEqual(['juraj@echobarrier.eu'])
  })

  it('sends the secret header when one is configured', async () => {
    process.env.N8N_CARGO_NOTIFY_WEBHOOK_SECRET = 'shhh'
    await notifyCargoPartnerReady(META, draft())
    const mock = fetch as unknown as ReturnType<typeof vi.fn>
    expect(mock.mock.calls[0][1].headers['x-hub-secret']).toBe('shhh')
  })

  it('carries the shipping details a forwarder needs to open an order', async () => {
    await notifyCargoPartnerReady(META, draft({ notes: 'Gate closes at 15:00' }))
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
    expect(s.notes).toBe('Gate closes at 15:00')

    const p = body.participants as Record<string, { account?: string; name?: string }>
    expect(p.shipper.account).toBe('446813')
    expect(p.principal.account).toBe('446813')
    expect(p.pickup.account).toBe('604070')
    expect(p.pickup.name).toBe('BAMIDA, s.r.o.')
    expect(p.office_in_charge.account).toBe('139461')
  })

  it('leaves the Incoterm null rather than inventing who pays for freight', async () => {
    await notifyCargoPartnerReady(META, draft())
    expect((lastBody().shipment as { delivery_term: unknown }).delivery_term).toBeNull()
  })

  it('carries the Incoterm once a person has chosen one', async () => {
    await notifyCargoPartnerReady(META, draft({ delivery_term: 'DAP' }))
    expect((lastBody().shipment as { delivery_term: unknown }).delivery_term).toBe('DAP')
  })

  it('sends the edited figures, not the ones the draft started with', async () => {
    await notifyCargoPartnerReady(META, draft({ pieces: 9, description: 'Acoustic Barriers H9 only' }))
    const s = lastBody().shipment as Record<string, unknown>
    expect(s.pieces).toBe(9)
    expect(s.description).toBe('Acoustic Barriers H9 only')
  })
})

describe('notifyCargoPartnerReady honours the test switch', () => {
  it('reaches only the test address, with the forwarder nowhere in the send', async () => {
    process.env.HUB_EMAIL_TEST_RECIPIENT = 'tester@example.com'
    await notifyCargoPartnerReady(META, draft())

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
    await notifyCargoPartnerReady(META, draft())
    const intended = lastBody().intended as { to: string[]; cc: string[] }
    expect(intended.to).toEqual(['bookings@forwarder.example'])
    expect(intended.cc).toEqual(['juraj@echobarrier.eu'])
  })
})

describe('notifyCargoPartnerReady, when it must not send', () => {
  it('sends nothing at all in the staging sandbox', async () => {
    process.env.NEXT_PUBLIC_HUB_ENV = 'staging'
    expect(await notifyCargoPartnerReady(META, draft())).toEqual({ sent: false, reason: 'staging' })
    expect(fetch as unknown as ReturnType<typeof vi.fn>).not.toHaveBeenCalled()
  })

  it('says so rather than throwing when no webhook is configured', async () => {
    delete process.env.N8N_CARGO_NOTIFY_WEBHOOK_URL
    expect(await notifyCargoPartnerReady(META, draft())).toEqual({ sent: false, reason: 'not_configured' })
    expect(fetch as unknown as ReturnType<typeof vi.fn>).not.toHaveBeenCalled()
  })

  it('refuses to send a request that names nobody', async () => {
    expect(await notifyCargoPartnerReady(META, draft({ to: '' }))).toEqual({
      sent: false,
      reason: 'not_configured',
    })
    expect(fetch as unknown as ReturnType<typeof vi.fn>).not.toHaveBeenCalled()
  })

  it('reports a failure rather than throwing when the webhook refuses', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('nope', { status: 500 })))
    expect(await notifyCargoPartnerReady(META, draft())).toEqual({ sent: false, reason: 'failed' })
  })
})

describe('buildCargoNotifyPayload', () => {
  it('names the destination depot the approved request carries', () => {
    const payload = buildCargoNotifyPayload(META, draft(), resolveRecipients({ to: 'a@x.com' }))
    const consignee = (payload.participants as { consignee: { depot: string | null; address: string | null } })
      .consignee
    expect(consignee.depot).toBe('US Baltimore')
    expect(consignee.address).toContain('Jessup')
  })

  it('uses the configured base url for the link', () => {
    process.env.NEXT_PUBLIC_HUB_BASE_URL = 'http://localhost:3000/'
    const payload = buildCargoNotifyPayload(META, draft(), resolveRecipients({ to: 'a@x.com' }))
    expect(payload.link).toBe(
      'http://localhost:3000/purchase-orders/11111111-2222-3333-4444-555555555555',
    )
  })
})
