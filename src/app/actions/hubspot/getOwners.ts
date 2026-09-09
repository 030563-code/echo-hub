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

/** One page loop over the owners endpoint. `archived` picks which register. */
async function fetchOwners(archived: boolean): Promise<HubSpotOwner[] | null> {
  const results: HubSpotOwner[] = []
  let after: string | undefined
  // Paginated because the portal has 107 owner records today (24 active, 83
  // archived) and no reason either register stays under 100 forever.
  for (let page = 0; page < 5; page++) {
    const url =
      `https://api.hubapi.com/crm/v3/owners?limit=100${archived ? '&archived=true' : ''}` +
      `${after ? `&after=${encodeURIComponent(after)}` : ''}`
    const response = await hubspotFetch(url)
    if (!response.ok) {
      console.error('getOwnerIndex failed', archived ? '(archived)' : '(active)', response.status)
      return null
    }
    const data = (await response.json()) as {
      results?: HubSpotOwner[]
      paging?: { next?: { after?: string } }
    }
    results.push(...(data.results ?? []))
    after = data.paging?.next?.after
    if (!after) break
  }
  return results
}

export async function getOwnerIndex(): Promise<OwnerIndex> {
  const empty: OwnerIndex = { ownerNameById: {}, teamNameById: {}, primaryTeamIdByOwnerId: {} }
  // pricing.manage reaches this through the contractor editor's company search,
  // the same widening searchCompanies already carries. Without it a pricing
  // admin sees a raw owner id where a colleague's name belongs.
  if (!(await hasAnyCapability(['quotes.view', 'quotes.create', 'pricing.manage']))) return empty
  if (cached && Date.now() - cached.at < TTL_MS) return cached.value

  // BOTH REGISTERS. The endpoint returns only active owners unless asked, and
  // this portal's departed reps still hold most of the CRM: measured 9 Sep
  // 2026, 5,796 of 9,500 companies belong to archived owners, two of them
  // holding 3,790 and 2,006. Indexing the active register alone printed
  // "Owner 30350649" against exactly the records that most need a name on them.
  // indexOwners already keeps archived entries; nothing had ever fetched them.
  const [active, archived] = await Promise.all([fetchOwners(false), fetchOwners(true)])
  // The active register is the one the deals board cannot do without. A failed
  // archived call costs names on old records, so it degrades rather than
  // discarding a good fetch.
  if (!active) return cached?.value ?? empty

  const value = indexOwners([...active, ...(archived ?? [])])
  cached = { at: Date.now(), value }
  return value
}
