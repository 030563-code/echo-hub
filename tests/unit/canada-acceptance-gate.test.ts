import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { HUBSPOT_PIPELINES } from '@/lib/hubspot-constants'

/**
 * The acceptance gate for Canada. Dean's decision (plan of 17 Sep 2026): a
 * CA-HAM deal moving to Quotation Accepted needs a delivery address and a
 * probability of close, the way a US one does, validated as a Canadian address.
 * Before this, a Canadian acceptance arrived with no address at all.
 *
 * HubSpot is a fake fetch that records every call, and the registry is a fake
 * session client that records every write. Nothing here reaches the CRM. Every
 * id and address is invented.
 */

const state = vi.hoisted(() => ({
  registryRow: null as Record<string, unknown> | null,
  registryWrites: [] as { op: string; payload: unknown }[],
}))

vi.mock('@/lib/authz', () => ({
  assertDealAccess: vi.fn(async () => ({
    ok: true,
    profile: { is_super_admin: true, allowed_depots: [] },
    pipelineId: '123',
  })),
}))
vi.mock('@/lib/env', () => ({ externalCallsDisabled: () => false, STAGING_SKIP_NOTE: 'Staging: nothing is written.' }))
vi.mock('@/lib/supabase/server', () => ({
  createServerClient: async () => ({
    from() {
      let op = 'select'
      const builder: Record<string, unknown> = {}
      Object.assign(builder, {
        select: () => builder,
        eq: () => builder,
        in: () => builder,
        maybeSingle: async () => ({ data: state.registryRow, error: null }),
        update: (payload: unknown) => {
          op = 'update'
          state.registryWrites.push({ op, payload })
          return builder
        },
        insert: (payload: unknown) => {
          op = 'insert'
          state.registryWrites.push({ op, payload })
          return builder
        },
        then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
          Promise.resolve({ data: op === 'update' ? [{ hubspot_deal_id: '990001' }] : null, error: null }).then(resolve, reject),
      })
      return builder
    },
  }),
}))

const hubspotCalls: { url: string; method: string; body: unknown }[] = []

beforeEach(() => {
  state.registryRow = { delivery_street: null, delivery_city: null, delivery_state: null, delivery_zip: null, deal_probability: null, is_collection: false }
  state.registryWrites = []
  hubspotCalls.length = 0
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    const method = init?.method ?? 'GET'
    hubspotCalls.push({ url, method, body: init?.body ? JSON.parse(init.body) : null })
    // The one read the gate makes: the deal's associated company.
    if (method === 'GET') return new Response(JSON.stringify({ associations: { companies: { results: [{ id: '880001' }] } } }), { status: 200 })
    return new Response('{}', { status: 200 })
  }))
})

afterEach(() => {
  vi.unstubAllGlobals()
})

const { updateDealStage } = await import('@/app/actions/hubspot/updateDealStage')

const PIPELINE = HUBSPOT_PIPELINES.USA_SALES.id
const ACCEPTED = HUBSPOT_PIPELINES.USA_SALES.stages.QUOTATION_ACCEPTED

const patches = () => hubspotCalls.filter((c) => c.method === 'PATCH')

describe('accepting a Canadian deal', () => {
  it('refuses without a delivery address, before anything is written anywhere', async () => {
    const res = await updateDealStage('990001', PIPELINE, ACCEPTED, 'CA-HAM', undefined, undefined, { winProbability: '50%' })
    expect(res).toEqual({ success: false, error: 'Delivery street address is required.' })
    expect(state.registryWrites).toEqual([])
    expect(patches()).toEqual([])
  })

  it('refuses California\'s code as a province, and a US zip as a postal code', async () => {
    const delivery = { street: '12 Invented Road', city: 'Faketown', state: 'CA', zip: 'M9X 9Z9' }
    const res = await updateDealStage('990001', PIPELINE, ACCEPTED, 'CA-HAM', undefined, undefined, { winProbability: '50%', delivery })
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/province/)

    const zip = await updateDealStage('990001', PIPELINE, ACCEPTED, 'CA-HAM', undefined, undefined, {
      winProbability: '50%',
      delivery: { ...delivery, state: 'ON', zip: '20794' },
    })
    expect(zip).toEqual({ success: false, error: 'Delivery postal code must be in the form A1A 1A1.' })
    expect(patches()).toEqual([])
  })

  it('refuses without a probability of close', async () => {
    const delivery = { street: '12 Invented Road', city: 'Faketown', state: 'ON', zip: 'M9X 9Z9' }
    const res = await updateDealStage('990001', PIPELINE, ACCEPTED, 'CA-HAM', undefined, undefined, { delivery })
    expect(res).toEqual({ success: false, error: 'Set the deal probability before accepting.' })
    expect(state.registryWrites).toEqual([])
    expect(patches()).toEqual([])
  })

  it('writes the address in the Canadian shape to the registry first, then moves the deal', async () => {
    const delivery = { street: '12  Invented Road', city: 'Faketown', state: 'Ontario', zip: 'm9x9z9' }
    const res = await updateDealStage('990001', PIPELINE, ACCEPTED, 'CA-HAM', undefined, undefined, { winProbability: '50%', delivery })
    expect(res).toEqual({ success: true })
    expect(state.registryWrites).toHaveLength(1)
    expect(state.registryWrites[0].payload).toMatchObject({
      delivery_street: '12 Invented Road',
      delivery_city: 'Faketown',
      delivery_state: 'ON',
      delivery_zip: 'M9X 9Z9',
      delivery_country: 'CA',
      deal_probability: 50,
      is_collection: false,
    })
    expect(patches()).toHaveLength(1)
    expect(patches()[0].body).toMatchObject({ properties: { dealstage: ACCEPTED, sending_depot: 'CA - Hamilton', win_probability: '50%' } })
  })

  it('needs no address for a Will Call order, and writes none', async () => {
    const res = await updateDealStage('990001', PIPELINE, ACCEPTED, 'CA-HAM', undefined, undefined, { winProbability: '50%', isCollection: true })
    expect(res).toEqual({ success: true })
    const payload = state.registryWrites[0].payload as Record<string, unknown>
    expect(payload.is_collection).toBe(true)
    expect(payload).not.toHaveProperty('delivery_country')
  })
})

describe('the other organisations are unchanged', () => {
  it('a US acceptance still needs a US address and writes the US shape', async () => {
    const refused = await updateDealStage('990001', PIPELINE, ACCEPTED, 'US-BAL', undefined, undefined, {
      winProbability: '50%',
      delivery: { street: '12 Invented Road', city: 'Faketown', state: 'ON', zip: 'M9X 9Z9' },
    })
    expect(refused).toEqual({ success: false, error: 'Delivery state must be a US state (2-letter code or full name).' })

    const res = await updateDealStage('990001', PIPELINE, ACCEPTED, 'US-BAL', undefined, undefined, {
      winProbability: '50%',
      delivery: { street: '12 Invented Road', city: 'Faketown', state: 'md', zip: '20794' },
    })
    expect(res).toEqual({ success: true })
    expect(state.registryWrites[0].payload).toMatchObject({ delivery_state: 'MD', delivery_zip: '20794', delivery_country: 'US' })
  })

  it('a depot with no invoicing profile keeps the depot-only rule: no address, no registry write', async () => {
    const res = await updateDealStage('990001', PIPELINE, ACCEPTED, 'EU-SK')
    expect(res).toEqual({ success: true })
    expect(state.registryWrites).toEqual([])
    expect(hubspotCalls.filter((c) => c.method === 'GET')).toEqual([])
  })
})
