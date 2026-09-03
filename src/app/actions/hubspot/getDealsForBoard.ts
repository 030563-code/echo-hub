'use server'

import { getAuthorizedUser } from '@/lib/authz'
import { hubspotFetch } from '@/lib/hubspot-client'
import { resolveHubSpotOwnerId } from '@/lib/hubspot-owner'
import { boardColumns, groupDealsByStage, type BoardColumn } from '@/lib/deals-board'
import { DEAL_LIST_PROPERTIES, type HubSpotDeal } from '@/lib/hubspot-types'
import { EMPTY_DEAL_FILTERS, buildDealFilterGroup, type HubSpotSearchFilter, type DealFilters } from '@/lib/deal-filters'
import { getOwnerIndex } from '@/app/actions/hubspot/getOwners'
import type { OwnerIndex } from '@/lib/hubspot-owners'

/**
 * The deals behind the board, grouped by their real HubSpot stage.
 *
 * Dean asked to replicate HubSpot's kanban and to let Dave "view all the deals
 * in Hubspot where it also shows the hubspot team pipeline associated with it".
 *
 * This is the working view of RECENT deals, not an exhaustive list: the USA
 * pipeline alone has 1,484 deals touched since May, and a board showing all of
 * them is a scroll bar rather than a tool. The All tab stays the complete
 * paginated list. Two search calls at the API maximum of 200 gives 400 deals,
 * well inside the five-per-second limit.
 */

const PAGE_SIZE = 200
const MAX_PAGES = 2

export interface BoardGroupResult {
  column: BoardColumn
  deals: HubSpotDeal[]
}

export type BoardScope = 'mine' | 'all'

export interface GetBoardResult {
  success: boolean
  error?: string
  groups?: BoardGroupResult[]
  /** True when the window held more deals than the cap. Said out loud on the
   *  page: a silently truncated board reads as a complete one. */
  truncated?: boolean
  isAdmin?: boolean
  scope?: BoardScope
  pipelineId?: string
  owners?: OwnerIndex
}

export async function getDealsForBoard(input: {
  scope?: BoardScope
  pipelineId?: string
  /** How far back to look. The board is for work in progress. */
  windowDays?: number
  /** Rep-set filters, folded into the SAME search call as everything else so
   *  HubSpot narrows before the 400-deal cap applies. Filtering the loaded
   *  cards instead would report "no such deal" for anything outside the
   *  window. */
  dealFilters?: DealFilters
}): Promise<GetBoardResult> {
  const auth = await getAuthorizedUser()
  if (!auth.ok) return { success: false, error: auth.error }
  if (!auth.capabilities.has('quotes.view') && !auth.capabilities.has('quotes.create')) {
    return { success: false, error: 'Forbidden: missing quotes capability' }
  }

  const accessToken = process.env.HUBSPOT_ACCESS_TOKEN
  if (!accessToken) return { success: false, error: 'HubSpot Access Token not configured' }

  const isAdmin = auth.profile.is_super_admin === true || auth.capabilities.has('admin')
  // Scope and pipeline are forced server-side, never taken on trust: they are
  // both URL parameters and widening either is exactly the thing to attempt.
  const scope: BoardScope = isAdmin && input.scope === 'all' ? 'all' : 'mine'
  const pipelineId = (isAdmin ? input.pipelineId : null) || auth.profile.pipeline_id || ''
  if (!pipelineId) {
    return { success: false, error: 'Your profile has no region set, so there is no pipeline to show.' }
  }

  // The owner filter is meaningless on a 'mine' board and actively harmful:
  // the scope below already pins hubspot_owner_id, so a second EQ on a
  // different owner ANDs to an empty board rather than being ignored. Only the
  // all-reps view can choose an owner.
  // The board pins its own pipeline above, so a pipeline filter is stripped for
  // the same reason as the owner one: a second EQ on a different value empties
  // the board instead of being ignored.
  const requested: DealFilters = { ...(input.dealFilters ?? EMPTY_DEAL_FILTERS), pipelineId: '' }
  const effectiveFilters: DealFilters = scope === 'all' ? requested : { ...requested, ownerId: '' }

  const columns = boardColumns(pipelineId)
  if (columns.length === 0) {
    return { success: false, error: 'That pipeline is not one the Hub knows about.' }
  }

  // Pinned server-side. The board always spends two of its six filters on the
  // pipeline and the recency window, and a third on the owner for a "my deals"
  // board, so a rep here has fewer to spend than one on the All tab.
  const pinned: HubSpotSearchFilter[] = [
    { propertyName: 'pipeline', operator: 'EQ', value: pipelineId },
    {
      propertyName: 'hs_lastmodifieddate',
      operator: 'GTE',
      value: String(Date.now() - (input.windowDays ?? 60) * 86_400_000),
    },
  ]

  if (scope === 'mine') {
    const ownerId = await resolveHubSpotOwnerId(auth.user.email ?? '', accessToken)
    // Fail closed. Without an owner id a "my deals" board would quietly become
    // everyone's.
    if (!ownerId) {
      return { success: false, error: `No HubSpot seat is linked to ${auth.user.email}, so your own deals cannot be listed.` }
    }
    pinned.push({ propertyName: 'hubspot_owner_id', operator: 'EQ', value: ownerId })
  }

  const group = buildDealFilterGroup(pinned, effectiveFilters)
  if (!group.ok) return { success: false, error: group.error }
  const filters = group.filters

  const deals: HubSpotDeal[] = []
  let after: string | undefined
  let truncated = false

  for (let page = 0; page < MAX_PAGES; page++) {
    const response = await hubspotFetch('https://api.hubapi.com/crm/v3/objects/deals/search', {
      method: 'POST',
      body: JSON.stringify({
        filterGroups: [{ filters }],
        properties: DEAL_LIST_PROPERTIES,
        sorts: [{ propertyName: 'hs_lastmodifieddate', direction: 'DESCENDING' }],
        limit: PAGE_SIZE,
        ...(after ? { after } : {}),
      }),
    })
    if (!response.ok) {
      console.error('getDealsForBoard search failed', response.status, await response.text().catch(() => ''))
      return { success: false, error: 'Could not load deals from HubSpot. Please try again.' }
    }
    const data = (await response.json()) as {
      results?: HubSpotDeal[]
      paging?: { next?: { after?: string } }
    }
    deals.push(...(data.results ?? []))
    after = data.paging?.next?.after
    if (!after) break
    if (page === MAX_PAGES - 1) truncated = true
  }

  // Only the admin view shows an owner column, so the extra call is only made
  // when something reads it.
  const owners = scope === 'all' ? await getOwnerIndex() : undefined

  return {
    success: true,
    groups: groupDealsByStage(deals, columns),
    truncated,
    isAdmin,
    scope,
    pipelineId,
    owners,
  }
}
