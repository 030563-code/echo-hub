import { describe, it, expect } from 'vitest'
import {
  associateLikeHubSpot,
  callIdsOnContact,
  mergedObjectId,
  openDealIds,
  primaryCompanyId,
} from '@/lib/calls/call-associations'
import type { HubSpotFetcher } from '@/lib/calls/hubspot-contact'

/**
 * A phone-system call reaches HubSpot with the contact alone. When a rep links
 * it, the Hub gives it what HubSpot's own logger would have: the contact's
 * primary company and the five most recent open deals. These pin the rule and
 * the exact requests, with no network.
 */

type Seen = { url: string; method: string; body: unknown }

function fakeFetcher(routes: Record<string, { status?: number; body: unknown }>) {
  const seen: Seen[] = []
  const fetcher = (async (url: string, init?: RequestInit) => {
    seen.push({ url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined })
    const key = Object.keys(routes).find((k) => url.includes(k))
    const route = key ? routes[key] : undefined
    return new Response(JSON.stringify(route?.body ?? {}), { status: route?.status ?? (key ? 200 : 404) })
  }) as unknown as HubSpotFetcher
  return { fetcher, seen }
}

const primary = (id: string) => ({
  toObjectId: id,
  associationTypes: [
    { category: 'HUBSPOT_DEFINED', typeId: 279, label: null },
    { category: 'HUBSPOT_DEFINED', typeId: 1, label: 'Primary' },
  ],
})
const plain = (id: string) => ({ toObjectId: id, associationTypes: [{ category: 'HUBSPOT_DEFINED', typeId: 279 }] })

describe('primaryCompanyId', () => {
  it('picks the company flagged Primary even when it is not first', () => {
    expect(primaryCompanyId([plain('1'), primary('2'), plain('3')])).toBe('2')
  })
  it('falls back to the first company when none is flagged', () => {
    expect(primaryCompanyId([plain('7'), plain('8')])).toBe('7')
  })
  it('is null with no companies', () => {
    expect(primaryCompanyId([])).toBeNull()
  })
})

describe('openDealIds', () => {
  const deal = (id: string, created: string, closed = 'false') => ({
    id,
    properties: { createdate: created, hs_is_closed: closed },
  })
  it('drops closed deals, sorts newest first, and stops at five', () => {
    const rows = [
      deal('old', '2026-01-01T00:00:00Z'),
      deal('won', '2026-09-01T00:00:00Z', 'true'),
      deal('d6', '2026-06-01T00:00:00Z'),
      deal('d5', '2026-05-01T00:00:00Z'),
      deal('d4', '2026-04-01T00:00:00Z'),
      deal('d3', '2026-03-01T00:00:00Z'),
      deal('newest', '2026-08-01T00:00:00Z'),
    ]
    expect(openDealIds(rows)).toEqual(['newest', 'd6', 'd5', 'd4', 'd3'])
  })
  it('treats a missing hs_is_closed as open', () => {
    expect(openDealIds([{ id: 9, properties: { createdate: '2026-02-02T00:00:00Z' } }])).toEqual(['9'])
  })
})

describe('mergedObjectId', () => {
  it('reads the survivor id HubSpot returns', async () => {
    expect(await mergedObjectId(new Response(JSON.stringify({ id: '248644682418' })), '1')).toBe('248644682418')
  })
  it('falls back when the body is not a record', async () => {
    expect(await mergedObjectId(new Response('not json'), '1')).toBe('1')
    expect(await mergedObjectId(new Response(JSON.stringify({ id: 'abc' })), '1')).toBe('1')
  })
})

describe('callIdsOnContact', () => {
  it('lists the call ids and drops junk', async () => {
    const { fetcher } = fakeFetcher({
      '/associations/calls': { body: { results: [{ toObjectId: 11 }, { toObjectId: '12' }, { toObjectId: 'x' }] } },
    })
    expect(await callIdsOnContact('5', fetcher)).toEqual(['11', '12'])
  })
  it('is empty when HubSpot fails', async () => {
    const { fetcher } = fakeFetcher({ '/associations/calls': { status: 500, body: {} } })
    expect(await callIdsOnContact('5', fetcher)).toEqual([])
  })
})

describe('associateLikeHubSpot', () => {
  it('puts the primary company and the open deals on every call, through the default batch endpoints', async () => {
    const { fetcher, seen } = fakeFetcher({
      '/associations/companies': { body: { results: [plain('c1'), primary('c2')] } },
      '/deals/search': {
        body: {
          results: [
            { id: 'd1', properties: { createdate: '2026-09-01T00:00:00Z', hs_is_closed: 'false' } },
            { id: 'd2', properties: { createdate: '2026-08-01T00:00:00Z', hs_is_closed: 'false' } },
          ],
        },
      },
      '/batch/associate/default': { body: { status: 'COMPLETE', results: [] } },
    })
    const outcome = await associateLikeHubSpot('42', ['call1', 'call2'], fetcher)
    expect(outcome).toEqual({ company: 'c2', deals: ['d1', 'd2'] })

    const search = seen.find((s) => s.url.includes('/deals/search'))
    expect(search?.body).toMatchObject({
      filterGroups: [
        {
          filters: [
            { propertyName: 'associations.contact', operator: 'EQ', value: '42' },
            { propertyName: 'hs_is_closed', operator: 'EQ', value: 'false' },
          ],
        },
      ],
      limit: 5,
    })

    const writes = seen.filter((s) => s.method === 'POST' && s.url.includes('/batch/associate/default'))
    expect(writes.map((w) => w.url)).toEqual([
      'https://api.hubapi.com/crm/v4/associations/calls/companies/batch/associate/default',
      'https://api.hubapi.com/crm/v4/associations/calls/deals/batch/associate/default',
    ])
    expect(writes[0].body).toEqual({
      inputs: [
        { from: { id: 'call1' }, to: { id: 'c2' } },
        { from: { id: 'call2' }, to: { id: 'c2' } },
      ],
    })
    expect((writes[1].body as { inputs: unknown[] }).inputs).toHaveLength(4)
  })

  it('writes nothing for a contact with no company and no open deals', async () => {
    const { fetcher, seen } = fakeFetcher({
      '/associations/companies': { body: { results: [] } },
      '/deals/search': { body: { results: [] } },
    })
    expect(await associateLikeHubSpot('42', ['call1'], fetcher)).toEqual({ company: null, deals: [] })
    expect(seen.filter((s) => s.url.includes('/batch/associate/default'))).toHaveLength(0)
  })

  it('does not even read when there are no calls', async () => {
    const { fetcher, seen } = fakeFetcher({})
    expect(await associateLikeHubSpot('42', [], fetcher)).toEqual({ company: null, deals: [] })
    expect(seen).toHaveLength(0)
  })

  it('is best effort: a refused write still returns', async () => {
    const { fetcher } = fakeFetcher({
      '/associations/companies': { body: { results: [primary('c9')] } },
      '/deals/search': { body: { results: [] } },
      '/batch/associate/default': { status: 400, body: { message: 'no' } },
    })
    expect(await associateLikeHubSpot('42', ['call1'], fetcher)).toEqual({ company: 'c9', deals: [] })
  })
})
