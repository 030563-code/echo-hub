import 'server-only'

import type { SupabaseClient } from '@supabase/supabase-js'
import { hubspotFetch } from '@/lib/hubspot-client'
import type { HubSpotFetcher } from '@/lib/calls/hubspot-contact'

/**
 * Fill in the public link of a published quote the publish step did not get.
 *
 * HubSpot mints hs_quote_link during the publish state change and hands it
 * back late: 7 of the first 10 quotes published from the Hub were stored with
 * no link, so "Copy link" did nothing and the rep had to go to HubSpot for it.
 * The publish step now waits longer; this catches whatever still slips
 * through, on the next render of the deal page, and writes it back so the
 * next render needs no read at all.
 */
export interface LinkableQuoteRow {
  id: string
  hubspot_quote_id: string | null
  status: string
  quote_link: string | null
  pdf_link: string | null
}

export async function backfillQuoteLinks<T extends LinkableQuoteRow>(
  admin: Pick<SupabaseClient, 'from'>,
  rows: readonly T[],
  fetcher: HubSpotFetcher = hubspotFetch,
): Promise<T[]> {
  const missing = rows.filter((row) => row.status === 'published' && !row.quote_link && row.hubspot_quote_id)
  if (missing.length === 0) return [...rows]
  try {
    const response = await fetcher('https://api.hubapi.com/crm/v3/objects/quotes/batch/read', {
      method: 'POST',
      body: JSON.stringify({
        properties: ['hs_quote_link', 'hs_pdf_download_link'],
        inputs: missing.map((row) => ({ id: String(row.hubspot_quote_id) })),
      }),
    })
    if (!response.ok) return [...rows]
    const data = (await response.json()) as {
      results?: { id: string; properties?: { hs_quote_link?: string | null; hs_pdf_download_link?: string | null } }[]
    }
    const found = new Map<string, { link: string; pdf: string | null }>()
    for (const result of data.results ?? []) {
      const link = String(result.properties?.hs_quote_link ?? '').trim()
      if (link !== '') found.set(String(result.id), { link, pdf: result.properties?.hs_pdf_download_link ?? null })
    }
    if (found.size === 0) return [...rows]

    const now = new Date().toISOString()
    await Promise.all(
      missing
        .filter((row) => found.has(String(row.hubspot_quote_id)))
        .map((row) => {
          const hit = found.get(String(row.hubspot_quote_id))!
          return admin
            .from('deal_quotes')
            .update({ quote_link: hit.link, ...(hit.pdf && !row.pdf_link ? { pdf_link: hit.pdf } : {}), updated_at: now })
            .eq('id', row.id)
        }),
    )
    return rows.map((row) => {
      const hit = row.hubspot_quote_id ? found.get(String(row.hubspot_quote_id)) : undefined
      if (!hit || row.quote_link) return row
      return { ...row, quote_link: hit.link, pdf_link: row.pdf_link ?? hit.pdf }
    })
  } catch (error) {
    console.error('backfillQuoteLinks failed', error instanceof Error ? error.message : error)
    return [...rows]
  }
}
