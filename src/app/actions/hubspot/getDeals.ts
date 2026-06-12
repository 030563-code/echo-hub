'use server'

import { createServerClient } from '@/lib/supabase/server'
import { QUOTE_REQUEST_STAGES, QUOTATION_SENT_STAGES, CLOSED_WON_STAGES, CLOSED_LOST_STAGES, DISTRIBUTOR_STAGES, QUOTATION_ACCEPTED_STAGES } from '@/lib/hubspot-constants'

const PAGE_SIZE = 25

interface HubSpotDeal {
  id: string
  properties: {
    dealname: string
    amount: string | null
    createdate: string
    dealstage: string
    pipeline: string
  }
}

interface GetDealsResult {
  success: boolean
  data?: HubSpotDeal[]
  error?: string
  hasNextPage?: boolean
  nextAfter?: string
}

export async function getDealsByStage(
  category: 'quote_requests' | 'quotation_sent' | 'pending' | 'all' | 'accepted' | 'won',
  page: number = 1,
  after?: string
): Promise<GetDealsResult> {
  const supabase = await createServerClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user || !user.email) {
    return { success: false, error: 'User not authenticated' }
  }

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
    } else if (category === 'pending') {
      // Pending = NOT (Quote Request OR Quotation Sent OR Won OR Lost OR Distributor OR Accepted)
      const excludedStages = [
        ...QUOTE_REQUEST_STAGES,
        ...QUOTATION_SENT_STAGES,
        ...CLOSED_WON_STAGES,
        ...CLOSED_LOST_STAGES,
        ...DISTRIBUTOR_STAGES,
        ...QUOTATION_ACCEPTED_STAGES
      ]
      stageFilters = [{ propertyName: 'dealstage', operator: 'NOT_IN', values: excludedStages }]
    } else {
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
      filterGroups: { filters: Array<HubSpotValueFilter | HubSpotStageFilter> }[]
      properties: string[]
      sorts: { propertyName: string; direction: string }[]
      limit: number
      after?: string
    }
    const requestBody: HubSpotSearchRequest = {
      filterGroups: [
        {
          filters: [
            {
              propertyName: 'hubspot_owner_id',
              operator: 'EQ',
              value: ownerId,
            },
            ...stageFilters
          ],
        },
      ],
      properties: ['dealname', 'amount', 'createdate', 'dealstage', 'pipeline'],
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
    }

  } catch (error: unknown) {
    console.error('getDealsByStage Exception:', error)
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
}
