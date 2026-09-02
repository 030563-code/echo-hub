'use server'

import { getAuthorizedUser, isDealInScope } from '@/lib/authz'

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
    /** Internal depot NAME (e.g. "US Baltimore"), set at latest on acceptance. */
    sending_depot?: string
    hubspot_owner_id?: string
    /** Rep-set probability of close, an option value like '70%'. */
    win_probability?: string
    /** ISO code, e.g. USD or CAD. The deal's own currency, and the only
     *  trustworthy source for it: the Hub used to assume USD. */
    deal_currency_code?: string
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
    const url = `https://api.hubapi.com/crm/v3/objects/deals/${dealId}?properties=dealname,amount,createdate,dealstage,pipeline,description,closedate,sending_depot,hubspot_owner_id,win_probability,deal_currency_code&associations=companies,contacts,line_item,line_items`

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

    // IDOR guard (finding #4): a rep may only read a deal they own or one in
    // their own pipeline, the same scope the deal lists use. Super admins
    // bypass. Don't leak existence of out-of-scope deals.
    if (!profile.is_super_admin) {
      const dealPipeline: string | null = data?.properties?.pipeline ?? null
      const dealOwnerId: string | null = data?.properties?.hubspot_owner_id ?? null
      if (!(await isDealInScope(dealPipeline, dealOwnerId, profile, auth.user.email))) {
        return { success: false, error: 'Deal not found' }
      }
    }

    return { success: true, data }

  } catch (error: unknown) {
    console.error('getDealDetails Exception:', error)
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
}
