'use server'

import { createServerClient } from '@/lib/supabase/server'
import { hasAnyCapability } from '@/lib/authz'

interface HubSpotTeam {
  id: string
  name: string
}

export async function getHubSpotTeams(): Promise<{ success: boolean; data?: HubSpotTeam[]; error?: string }> {
  const supabase = await createServerClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) return { success: false, error: 'Unauthorized' }
  // APP-3: CRM-proxy read requires quotes access.
  if (!(await hasAnyCapability(['quotes.view', 'quotes.create']))) {
    return { success: false, error: 'Forbidden: missing quotes capability' }
  }

  const accessToken = process.env.HUBSPOT_ACCESS_TOKEN
  if (!accessToken) return { success: false, error: 'Token Missing' }

  try {
    const response = await fetch('https://api.hubapi.com/settings/v3/users/teams', {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
      cache: 'no-store'
    })

    if (!response.ok) {
      return { success: false, error: 'Failed to fetch teams' }
    }

    const data = await response.json()
    return { success: true, data: data.results }

  } catch (error: unknown) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
}
