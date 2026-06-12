'use server'

import { createServerClient } from '@/lib/supabase/server'
import { hasAnyCapability } from '@/lib/authz'

interface HubSpotCompany {
  id: string
  properties: {
    name: string
    domain?: string
    city?: string
    state?: string
    country?: string
    phone?: string
  }
}

interface GetCompanyDetailsResult {
  success: boolean
  data?: HubSpotCompany
  error?: string
}

export async function getCompanyDetails(companyId: string): Promise<GetCompanyDetailsResult> {
  const supabase = await createServerClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    return { success: false, error: 'User not authenticated' }
  }

  // Module capability gate — object-level reads require quotes access (closes the
  // residual object-level IDOR: any authenticated user reading any company by id).
  if (!(await hasAnyCapability(['quotes.view', 'quotes.create']))) {
    return { success: false, error: 'Forbidden: missing quotes capability' }
  }

  const accessToken = process.env.HUBSPOT_ACCESS_TOKEN
  if (!accessToken) {
    return { success: false, error: 'HubSpot Access Token not configured' }
  }

  try {
    const response = await fetch(
      `https://api.hubapi.com/crm/v3/objects/companies/${companyId}?properties=name,domain,city,state,country,phone`,
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
        return { success: false, error: 'Company not found' }
      }
      const errorText = await response.text()
      console.error('HubSpot Get Company API Error:', errorText)
      return { success: false, error: 'Failed to fetch company details' }
    }

    const data = await response.json()
    return { success: true, data }

  } catch (error: unknown) {
    console.error('getCompanyDetails Exception:', error)
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
}
