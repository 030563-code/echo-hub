'use server'

import { getAuthorizedUser } from '@/lib/authz'

interface HubSpotDealDetails {
  id: string
  properties: {
    dealname: string
    amount: string | null
    createdate: string
    dealstage: string
    pipeline: string
    hs_object_id: string
    // Add other relevant properties here
    description?: string
    closedate?: string
  }
  associations?: {
    companies?: { results: { id: string }[] }
    contacts?: { results: { id: string }[] }
    line_items?: { results: { id: string }[] } // HubSpot might return this key even if we request 'line_item'
    line_item?: { results: { id: string }[] } // Or this one
  }
}

interface GetDealDetailsResult {
  success: boolean
  data?: HubSpotDealDetails
  error?: string
}

export async function getDealDetails(dealId: string): Promise<GetDealDetailsResult> {
  const auth = await getAuthorizedUser()
  if (!auth.ok) {
    return { success: false, error: auth.error }
  }
  const { profile } = auth

  if (!dealId || !/^\d+$/.test(dealId)) {
    return { success: false, error: 'Invalid deal id' }
  }

  const accessToken = process.env.HUBSPOT_ACCESS_TOKEN
  if (!accessToken) {
    return { success: false, error: 'HubSpot Access Token not configured' }
  }

  try {
    // Fetch Deal Details with Associations and Line Items
    // Requesting both singular and plural to be safe
    const url = `https://api.hubapi.com/crm/v3/objects/deals/${dealId}?properties=dealname,amount,createdate,dealstage,pipeline,description,closedate&associations=companies,contacts,line_item,line_items`

    const response = await fetch(
      url,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        cache: 'no-store',
      }
    )

    if (!response.ok) {
      if (response.status === 404) {
        return { success: false, error: 'Deal not found' }
      }
      const errorText = await response.text()
      console.error('HubSpot Get Deal API Error:', errorText)
      return { success: false, error: 'Failed to fetch deal details' }
    }

    const data = await response.json()

    // IDOR guard (finding #4): an agent may only read deals in their own
    // pipeline. Super admins bypass. Don't leak existence of out-of-pipeline deals.
    if (!profile.is_super_admin) {
      const dealPipeline: string | null = data?.properties?.pipeline ?? null
      if (!profile.pipeline_id || dealPipeline !== profile.pipeline_id) {
        return { success: false, error: 'Deal not found' }
      }
    }

    return { success: true, data }

  } catch (error: unknown) {
    console.error('getDealDetails Exception:', error)
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
}
