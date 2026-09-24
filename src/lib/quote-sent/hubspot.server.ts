import 'server-only'

import { hubspotFetch } from '@/lib/hubspot-client'
import type { QuoteSentHubSpot } from './run'
import { parseAddresses, type DealFacts, type EmailFacts, type Pipeline, type QuoteFacts } from './rule'

/**
 * The quote-sent check's reads of HubSpot, and its one write (dealstage).
 *
 * Everything goes through hubspotFetch, so the staging kill switch holds for the write, and
 * /search and /batch/read pass as the reads they are. Scopes the Hub app already holds:
 * sales-email-read for logged email, crm.objects.quotes.read, crm.objects.owners.read and
 * crm.objects.deals.write.
 */

const API = 'https://api.hubapi.com'
// One window of half an hour holds a handful of emails. This is a runaway guard, not a limit.
const MAX_SEARCH_PAGES = 20

async function read<T>(res: Response, what: string): Promise<T> {
  if (!res.ok) throw new Error(`HubSpot ${what}: HTTP ${res.status}`)
  return (await res.json()) as T
}

const post = (path: string, body: unknown) =>
  hubspotFetch(`${API}${path}`, { method: 'POST', body: JSON.stringify(body) })

function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

type AssociationRows = { results?: { from: { id: string | number }; to?: { toObjectId: string | number }[] }[] }

async function associations(from: string, to: string, ids: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>()
  for (const part of chunks(ids, 100)) {
    const body = await read<AssociationRows>(
      await post(`/crm/v4/associations/${from}/${to}/batch/read`, { inputs: part.map((id) => ({ id })) }),
      `${from} to ${to}`,
    )
    for (const row of body.results ?? []) out.set(String(row.from.id), (row.to ?? []).map((t) => String(t.toObjectId)))
  }
  return out
}

type DealRow = {
  id: string
  properties: Record<string, string | null>
  propertiesWithHistory?: { dealstage?: { value: string; timestamp: string }[] }
}

function toDeal(row: DealRow): DealFacts {
  const history = (row.propertiesWithHistory?.dealstage ?? [])
    .map((h) => ({ stageId: h.value, at: h.timestamp }))
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
  return {
    id: String(row.id),
    pipelineId: row.properties.pipeline ?? '',
    stageId: row.properties.dealstage ?? '',
    isClosed: row.properties.hs_is_closed === 'true',
    stageHistory: history,
  }
}

const DEAL_PROPERTIES = ['dealstage', 'pipeline', 'hs_is_closed']

export const hubspotQuoteSentPort: QuoteSentHubSpot = {
  async pipelines(): Promise<Pipeline[]> {
    const body = await read<{
      results: { id: string; stages: { id: string; displayOrder: number; metadata?: { isClosed?: string } }[] }[]
    }>(await hubspotFetch(`${API}/crm/v3/pipelines/deals`), 'pipelines')
    return body.results.map((p) => ({
      id: p.id,
      stages: p.stages.map((s) => ({ id: s.id, displayOrder: s.displayOrder, isClosed: s.metadata?.isClosed === 'true' })),
    }))
  },

  async outgoingEmailIds(fromMs, toMs) {
    const ids: string[] = []
    let after: string | undefined
    for (let page = 0; page < MAX_SEARCH_PAGES; page++) {
      const body = await read<{ results: { id: string }[]; paging?: { next?: { after?: string } } }>(
        await post('/crm/v3/objects/emails/search', {
          filterGroups: [
            {
              filters: [
                // Created, not sent: when HubSpot logged it, which is what a window can chain on.
                { propertyName: 'hs_createdate', operator: 'GTE', value: String(fromMs) },
                { propertyName: 'hs_createdate', operator: 'LT', value: String(toMs) },
                { propertyName: 'hs_email_direction', operator: 'EQ', value: 'EMAIL' },
              ],
            },
          ],
          sorts: [{ propertyName: 'hs_createdate', direction: 'ASCENDING' }],
          properties: ['hs_createdate'],
          limit: 100,
          ...(after ? { after } : {}),
        }),
        'email search',
      )
      ids.push(...body.results.map((r) => String(r.id)))
      after = body.paging?.next?.after
      if (!after) return ids
    }
    throw new Error(`more than ${MAX_SEARCH_PAGES * 100} logged emails in one window`)
  },

  dealIdsForEmails: (emailIds) => associations('emails', 'deals', emailIds),

  async readDeals(dealIds) {
    const out: DealFacts[] = []
    // A batch that asks for property history takes 50 records at most.
    for (const part of chunks(dealIds, 50)) {
      const body = await read<{ results: DealRow[] }>(
        await post('/crm/v3/objects/deals/batch/read', {
          properties: DEAL_PROPERTIES,
          propertiesWithHistory: ['dealstage'],
          inputs: part.map((id) => ({ id })),
        }),
        'deals',
      )
      out.push(...body.results.map(toDeal))
    }
    return out
  },

  async quotesForDeals(dealIds) {
    const byDeal = await associations('deals', 'quotes', dealIds)
    const quoteIds = [...new Set([...byDeal.values()].flat())]
    const facts = new Map<string, QuoteFacts>()
    for (const part of chunks(quoteIds, 100)) {
      const body = await read<{ results: { id: string; properties: Record<string, string | null> }[] }>(
        await post('/crm/v3/objects/quotes/batch/read', {
          properties: ['hs_quote_link', 'hs_createdate'],
          inputs: part.map((id) => ({ id })),
        }),
        'quotes',
      )
      for (const q of body.results) {
        facts.set(String(q.id), {
          id: String(q.id),
          link: q.properties.hs_quote_link?.trim() || null,
          createdAt: q.properties.hs_createdate ?? null,
        })
      }
    }
    const out = new Map<string, QuoteFacts[]>()
    for (const [dealId, ids] of byDeal) {
      out.set(dealId, ids.map((id) => facts.get(id)).filter((q): q is QuoteFacts => !!q))
    }
    return out
  },

  async readEmails(emailIds) {
    const out: EmailFacts[] = []
    for (const part of chunks(emailIds, 100)) {
      const body = await read<{ results: { id: string; properties: Record<string, string | null> }[] }>(
        await post('/crm/v3/objects/emails/batch/read', {
          properties: [
            'hs_email_direction',
            'hs_timestamp',
            'hs_email_text',
            'hs_email_html',
            'hs_email_to_email',
            'hs_email_cc_email',
          ],
          inputs: part.map((id) => ({ id })),
        }),
        'emails',
      )
      for (const e of body.results) {
        const p = e.properties
        out.push({
          id: String(e.id),
          direction: p.hs_email_direction ?? null,
          sentAt: p.hs_timestamp ?? null,
          body: `${p.hs_email_text ?? ''}\n${p.hs_email_html ?? ''}`,
          recipients: parseAddresses(p.hs_email_to_email, p.hs_email_cc_email),
        })
      }
    }
    return out
  },

  async userEmails() {
    const out = new Set<string>()
    // Archived users too: a colleague who has left can still be on an old thread.
    for (const archived of ['false', 'true']) {
      let after: string | undefined
      do {
        const body = await read<{ results: { email?: string | null }[]; paging?: { next?: { after?: string } } }>(
          await hubspotFetch(`${API}/crm/v3/owners?limit=500&archived=${archived}${after ? `&after=${after}` : ''}`),
          'owners',
        )
        for (const o of body.results) if (o.email) out.add(o.email.trim().toLowerCase())
        after = body.paging?.next?.after
      } while (after)
    }
    return out
  },

  async readDeal(dealId) {
    const res = await hubspotFetch(
      `${API}/crm/v3/objects/deals/${encodeURIComponent(dealId)}?properties=${DEAL_PROPERTIES.join(',')}&propertiesWithHistory=dealstage`,
    )
    if (res.status === 404) return null
    return toDeal(await read<DealRow>(res, 'deal'))
  },

  async moveDeal(dealId, stageId) {
    // dealstage alone, as markQuoteSent writes it: the pipeline is never written back, so a stale
    // read cannot move a deal between pipelines.
    const res = await hubspotFetch(`${API}/crm/v3/objects/deals/${encodeURIComponent(dealId)}`, {
      method: 'PATCH',
      body: JSON.stringify({ properties: { dealstage: stageId } }),
    })
    if (!res.ok) throw new Error(`HubSpot refused the stage change: HTTP ${res.status}`)
  },
}
