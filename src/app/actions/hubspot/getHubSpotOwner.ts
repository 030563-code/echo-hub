'use server'

import { createServerClient } from '@/lib/supabase/server'

interface HubSpotOwner {
  id: string
  email: string
  firstName: string
  lastName: string
  userId: number | null
  archived: boolean
  teams?: { id: string; name: string; primary: boolean }[]
}

interface GetOwnerResult {
  success: boolean
  owner?: HubSpotOwner
  error?: string
}

export async function getHubSpotOwnerByEmail(email: string): Promise<GetOwnerResult> {
  // Auth guard
  const supabase = await createServerClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { success: false, error: 'Unauthorized' }

  const { data: profile } = await supabase
    .from('profiles')
    .select('is_super_admin')
    .eq('id', user.id)
    .maybeSingle()
  if (!profile?.is_super_admin) return { success: false, error: 'Forbidden' }

  // Token guard
  const apiKey = process.env.HUBSPOT_ACCESS_TOKEN
  if (!apiKey) return { success: false, error: 'HubSpot access token not configured' }

  // HubSpot API call
  const url = `https://api.hubapi.com/crm/v3/owners?email=${encodeURIComponent(email)}`

  try {
    const response = await fetch(url, {
      cache: 'no-store',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
    })

    if (!response.ok) {
      const body = await response.text()
      console.error(`HubSpot owners API error ${response.status}:`, body)
      return { success: false, error: 'HubSpot API error' }
    }

    const data = await response.json()
    const results: HubSpotOwner[] = data.results ?? []

    // Apply filter rules: archived=false, userId!=null, teams.length>0, not a hubspot.com email
    const owner = results.find(
      (o) =>
        !o.archived &&
        o.userId !== null &&
        (o.teams?.length ?? 0) > 0 &&
        !o.email.endsWith('@hubspot.com')
    )

    if (!owner) {
      return { success: false, error: 'This email is not a registered HubSpot sales owner' }
    }

    return { success: true, owner }
  } catch {
    return { success: false, error: 'HubSpot API error' }
  }
}
