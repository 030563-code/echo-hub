'use server'

import { createServerClient } from '@/lib/supabase/server'

interface CreateCompanyParams {
  name: string
  domain: string
}

export async function createHubSpotCompany(params: CreateCompanyParams): Promise<{ success: boolean; companyId?: string; error?: string }> {
  const supabase = await createServerClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) return { success: false, error: 'Unauthorized' }

  const accessToken = process.env.HUBSPOT_ACCESS_TOKEN
  if (!accessToken) return { success: false, error: 'Token Missing' }

  try {
    const response = await fetch('https://api.hubapi.com/crm/v3/objects/companies', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        properties: {
          name: params.name,
          domain: params.domain
        }
      }),
      cache: 'no-store'
    })

    if (!response.ok) {
      const errorText = await response.text()
      console.error('HubSpot Create Company Error:', errorText)
      return { success: false, error: 'Failed to create company in HubSpot' }
    }

    const data = await response.json()
    return { success: true, companyId: data.id }

  } catch (error: unknown) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
}
