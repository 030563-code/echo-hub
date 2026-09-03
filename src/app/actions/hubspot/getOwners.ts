'use server'

import { hubspotFetch } from '@/lib/hubspot-client'
import { hasAnyCapability } from '@/lib/authz'
import { indexOwners, type HubSpotOwner, type OwnerIndex } from '@/lib/hubspot-owners'

/**
 * The portal's owners, indexed to names once and reused for every deal row.
 *
 * Dean asked that Dave see all the deals "where it also shows the hubspot team
 * pipeline associated with it". A deal carries owner and team ids and nothing
 * else, and this portal's token gets 403 on settings/v3/users, so the owners
 * endpoint is the only route to the names.
 *
 * Memoised in a module-level map with a short TTL, the same shape as
 * hubspot-owner.ts. React cache() would be per request and refetch all 23
 * owners on every board render; this survives across them. Failures are never
 * cached, so a blip does not pin the board to raw ids for ten minutes.
 */

const TTL_MS = 10 * 60 * 1000
let cached: { at: number; value: OwnerIndex } | null = null

export async function getOwnerIndex(): Promise<OwnerIndex> {
  const empty: OwnerIndex = { ownerNameById: {}, teamNameById: {}, primaryTeamIdByOwnerId: {} }
  if (!(await hasAnyCapability(['quotes.view', 'quotes.create']))) return empty
  if (cached && Date.now() - cached.at < TTL_MS) return cached.value

  const results: HubSpotOwner[] = []
  let after: string | undefined
  // Paginated because the portal has 23 owners today and no reason it stays
  // under 100 forever.
  for (let page = 0; page < 5; page++) {
    const url = `https://api.hubapi.com/crm/v3/owners?limit=100${after ? `&after=${encodeURIComponent(after)}` : ''}`
    const response = await hubspotFetch(url)
    if (!response.ok) {
      console.error('getOwnerIndex failed', response.status)
      return cached?.value ?? empty
    }
    const data = (await response.json()) as {
      results?: HubSpotOwner[]
      paging?: { next?: { after?: string } }
    }
    results.push(...(data.results ?? []))
    after = data.paging?.next?.after
    if (!after) break
  }

  const value = indexOwners(results)
  cached = { at: Date.now(), value }
  return value
}
