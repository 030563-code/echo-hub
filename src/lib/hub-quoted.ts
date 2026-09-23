import 'server-only'

import { createAdminClient } from '@/lib/supabase/admin'

/**
 * Which of these HubSpot deals were quoted through the Hub.
 *
 * Dean, 23 Sep 2026: an EH mark on each board card "so we can see which deals are done through
 * the hub and which are not". The rule lives in the view public.hub_quoted_deals and nowhere else,
 * because the CSO's desk pack reads the same view to answer "which quotes did not go through the
 * Hub". Two copies of the rule would drift, and the board and the CSO would disagree about the
 * same deal.
 *
 * The view is server only, so this reads it with the admin client. It is only ever asked about ids
 * the caller has already been shown (the board's own HubSpot search), so all it adds is a yes or
 * no on deals the viewer can see anyway.
 *
 * `ok: false` does not mean "none of them". A board that drew no marks because this read failed
 * would say, wrongly, that nothing on it went through the Hub, so the caller says it could not
 * check instead.
 */

/** Ids per request. 150 HubSpot deal ids keep the PostgREST query string near 2 KB. */
const CHUNK = 150

export type HubQuotedResult = { ok: true; ids: string[] } | { ok: false }

export async function hubQuotedDealIds(dealIds: readonly string[]): Promise<HubQuotedResult> {
  const unique = [...new Set(dealIds.map((id) => String(id).trim()).filter(Boolean))]
  if (unique.length === 0) return { ok: true, ids: [] }

  const chunks: string[][] = []
  for (let i = 0; i < unique.length; i += CHUNK) chunks.push(unique.slice(i, i + CHUNK))

  const admin = createAdminClient()
  const reads = await Promise.all(
    chunks.map((ids) => admin.from('hub_quoted_deals').select('hubspot_deal_id').in('hubspot_deal_id', ids)),
  )

  const ids: string[] = []
  for (const { data, error } of reads) {
    if (error) {
      console.error('hub_quoted_deals read failed', error.message)
      return { ok: false }
    }
    for (const row of data ?? []) ids.push(String(row.hubspot_deal_id))
  }
  return { ok: true, ids }
}
