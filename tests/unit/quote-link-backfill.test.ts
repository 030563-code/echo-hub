import { describe, it, expect } from 'vitest'
import { backfillQuoteLinks } from '@/lib/quote-link-backfill'
import type { HubSpotFetcher } from '@/lib/calls/hubspot-contact'

/** HubSpot hands the public link back late; the deal page fills it in later. */
function fakeAdmin() {
  const updates: { id: string; patch: Record<string, unknown> }[] = []
  const admin = {
    from: () => ({
      update: (patch: Record<string, unknown>) => ({
        eq: async (_col: string, id: string) => {
          updates.push({ id, patch })
          return { error: null }
        },
      }),
    }),
  }
  return { admin: admin as never, updates }
}

const rows = [
  { id: 'a', hubspot_quote_id: '1', status: 'published', quote_link: null, pdf_link: null },
  { id: 'b', hubspot_quote_id: '2', status: 'published', quote_link: 'https://info.echobarrier.com/have', pdf_link: null },
  { id: 'c', hubspot_quote_id: '3', status: 'editing', quote_link: null, pdf_link: null },
  { id: 'd', hubspot_quote_id: null, status: 'published', quote_link: null, pdf_link: null },
]

describe('backfillQuoteLinks', () => {
  it('reads only the published rows with no link, stores what HubSpot has, and returns filled rows', async () => {
    const seen: string[] = []
    const fetcher = (async (url: string, init?: RequestInit) => {
      seen.push(String(JSON.parse(String(init?.body)).inputs.map((i: { id: string }) => i.id)))
      return new Response(JSON.stringify({ results: [{ id: '1', properties: { hs_quote_link: 'https://info.echobarrier.com/new', hs_pdf_download_link: 'https://pdf' } }] }))
    }) as unknown as HubSpotFetcher
    const { admin, updates } = fakeAdmin()
    const out = await backfillQuoteLinks(admin, rows, fetcher)
    expect(seen).toEqual(['1'])
    expect(updates).toEqual([{ id: 'a', patch: expect.objectContaining({ quote_link: 'https://info.echobarrier.com/new', pdf_link: 'https://pdf' }) }])
    expect(out[0].quote_link).toBe('https://info.echobarrier.com/new')
    expect(out[1].quote_link).toBe('https://info.echobarrier.com/have')
    expect(out[2].quote_link).toBeNull()
  })

  it('makes no request when nothing is missing', async () => {
    let calls = 0
    const fetcher = (async () => { calls++; return new Response('{}') }) as unknown as HubSpotFetcher
    const { admin } = fakeAdmin()
    await backfillQuoteLinks(admin, [rows[1], rows[2]], fetcher)
    expect(calls).toBe(0)
  })

  it('leaves the rows alone when HubSpot still has no link or fails', async () => {
    const fetcher = (async () => new Response(JSON.stringify({ results: [{ id: '1', properties: { hs_quote_link: null } }] }))) as unknown as HubSpotFetcher
    const { admin, updates } = fakeAdmin()
    const out = await backfillQuoteLinks(admin, rows, fetcher)
    expect(updates).toEqual([])
    expect(out[0].quote_link).toBeNull()
    const failing = (async () => new Response('nope', { status: 500 })) as unknown as HubSpotFetcher
    expect((await backfillQuoteLinks(admin, rows, failing))[0].quote_link).toBeNull()
  })
})
