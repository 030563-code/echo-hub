'use server'

import { createServerClient } from '@/lib/supabase/server'
import { getAuthorizedUser, hasAnyCapability } from '@/lib/authz'
import { QUOTE_REQUEST_STAGES, QUOTATION_SENT_STAGES, CLOSED_WON_STAGES, QUOTATION_ACCEPTED_STAGES } from '@/lib/hubspot-constants'
import type { HubSpotDeal } from '@/lib/hubspot-types'
import { DEAL_LIST_PROPERTIES } from '@/lib/hubspot-types'
import { EMPTY_DEAL_FILTERS, dealFiltersToHubSpot, type DealFilters } from '@/lib/deal-filters'

const PAGE_SIZE = 25


interface GetDealsResult {
  success: boolean
  data?: HubSpotDeal[]
  error?: string
  hasNextPage?: boolean
  /** Whether the caller may ask for every rep's deals, so the page knows
   *  whether to offer the toggle. */
  isAdmin?: boolean
  nextAfter?: string
}

export async function getDealsByStage(
  category: 'quote_requests' | 'quotation_sent' | 'all' | 'accepted' | 'won',
  page: number = 1,
  after?: string,
  /**
   * 'all' drops the owner filter so an admin sees every rep's deals. Dean asked
   * that "Dave should have access to also view all the deals in Hubspot".
   * Decided server-side from the caller's own profile: this arrives from a URL
   * parameter, and widening it is exactly the thing to try.
   */
  scope: 'mine' | 'all' = 'mine',
  /**
   * Rep-set filters, folded into the same search call as the stage category.
   * Optional and defaulted, so the four existing call sites keep working.
   */
  dealFilters: DealFilters = EMPTY_DEAL_FILTERS
): Promise<GetDealsResult> {
  const supabase = await createServerClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user || !user.email) {
    return { success: false, error: 'User not authenticated' }
  }
  // APP-3: CRM-proxy read requires quotes access.
  if (!(await hasAnyCapability(['quotes.view', 'quotes.create']))) {
    return { success: false, error: 'Forbidden: missing quotes capability' }
  }

  const auth = await getAuthorizedUser()
  const isAdmin = auth.ok && (auth.profile.is_super_admin === true || auth.capabilities.has('admin'))
  const allReps = scope === 'all' && isAdmin

  const accessToken = process.env.HUBSPOT_ACCESS_TOKEN
  if (!accessToken) {
    return { success: false, error: 'HubSpot Access Token not configured' }
  }

  try {
    // Step A: Get HubSpot Owner ID
    const ownerResponse = await fetch(
      `https://api.hubapi.com/crm/v3/owners/?email=${encodeURIComponent(user.email)}`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        cache: 'no-store',
      }
    )

    if (!ownerResponse.ok) {
      return { success: false, error: 'Failed to fetch HubSpot owner' }
    }

    const ownerData = await ownerResponse.json()
    const ownerId = ownerData.results?.[0]?.id

    if (!ownerId) {
      return { success: false, error: `HubSpot Owner ID not found for email: ${user.email}` }
    }

    // Determine Stages based on Category
    interface HubSpotStageFilter {
      propertyName: string
      operator: string
      values: readonly string[]
    }
    let stageFilters: HubSpotStageFilter[] = []

    if (category === 'quote_requests') {
      stageFilters = [{ propertyName: 'dealstage', operator: 'IN', values: QUOTE_REQUEST_STAGES }]
    } else if (category === 'quotation_sent') {
      stageFilters = [{ propertyName: 'dealstage', operator: 'IN', values: QUOTATION_SENT_STAGES }]
    } else if (category === 'accepted') {
      stageFilters = [{ propertyName: 'dealstage', operator: 'IN', values: QUOTATION_ACCEPTED_STAGES }]
    } else if (category === 'won') {
      stageFilters = [{ propertyName: 'dealstage', operator: 'IN', values: CLOSED_WON_STAGES }]
    } else {
      // The 'pending' category is gone with the tab it fed. It was defined as
      // NOT six stage families, which swept up Tender and General pricing and
      // then labelled every row "Pending". Real stages are on the board now.
      // All deals for this owner (no stage filter)
      stageFilters = []
    }

    // Step B: Fetch Deals with pagination
    interface HubSpotValueFilter {
      propertyName: string
      operator: string
      value: string
    }
    interface HubSpotSearchRequest {
      filterGroups: { filters: Array<HubSpotValueFilter | HubSpotStageFilter | { propertyName: string; operator: string; value?: string; values?: string[] }> }[]
      properties: string[]
      sorts: { propertyName: string; direction: string }[]
      limit: number
      after?: string
    }
    const requestBody: HubSpotSearchRequest = {
      filterGroups: [
        {
          filters: [
            // Dropped only for an admin who asked for every rep. A non-admin,
            // or an admin who did not ask, still sees their own deals.
            ...(allReps
              ? []
              : [{ propertyName: 'hubspot_owner_id', operator: 'EQ', value: ownerId }]),
            ...stageFilters,
            // An admin viewing every rep can filter to one owner. On a 'mine'
            // list the owner is already pinned above, so a second EQ would AND
            // to an empty page instead of being ignored.
            ...dealFiltersToHubSpot(allReps ? dealFilters : { ...dealFilters, ownerId: '' }),
          ],
        },
      ],
      properties: [...DEAL_LIST_PROPERTIES],
      sorts: [
        {
          propertyName: 'createdate',
          direction: 'DESCENDING',
        },
      ],
      limit: PAGE_SIZE,
    }

    // HubSpot uses cursor-based pagination via the `after` parameter
    if (after) {
      requestBody.after = after
    }

    const searchResponse = await fetch(
      'https://api.hubapi.com/crm/v3/objects/deals/search',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestBody),
        cache: 'no-store',
      }
    )

    if (!searchResponse.ok) {
      const errorText = await searchResponse.text()
      console.error('HubSpot Deal Search API Error:', errorText)
      return { success: false, error: 'Failed to fetch deals from HubSpot' }
    }

    const searchData = await searchResponse.json()
    const nextAfter = searchData.paging?.next?.after as string | undefined
    const hasNextPage = !!nextAfter

    return {
      success: true,
      data: searchData.results,
      hasNextPage,
      nextAfter,
      isAdmin,
    }

  } catch (error: unknown) {
    console.error('getDealsByStage Exception:', error)
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
}
