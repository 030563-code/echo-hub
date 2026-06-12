'use server'

import { createServerClient } from '@/lib/supabase/server'

interface PropertyOption {
  label: string
  value: string
  displayOrder: number
  hidden: boolean
}

interface HubSpotProperty {
  options?: PropertyOption[]
}

async function fetchHubSpotProperty(slug: string, accessToken: string): Promise<{ ok: boolean; data?: HubSpotProperty; error?: string }> {
  try {
    const response = await fetch(`https://api.hubapi.com/crm/v3/properties/deals/${slug}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      cache: 'no-store'
    })

    if (!response.ok) {
      const errorText = await response.text()
      console.error(`HubSpot Get Property Error (${slug}):`, errorText)
      return { ok: false, error: `Failed to fetch ${slug} options` }
    }

    const data = await response.json()
    return { ok: true, data }
  } catch (error: unknown) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export async function getDealCurrencyOptions(): Promise<{ success: boolean; data?: PropertyOption[]; error?: string }> {
  const supabase = await createServerClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { success: false, error: 'Unauthorized' }

  const accessToken = process.env.HUBSPOT_ACCESS_TOKEN
  if (!accessToken) return { success: false, error: 'Token Missing' }

  const result = await fetchHubSpotProperty('deal_currency_code', accessToken)
  if (!result.ok) return { success: false, error: result.error }

  const options = (result.data?.options || []).filter((opt: PropertyOption) => !opt.hidden)
  return { success: true, data: options }
}

export async function getWinProbabilityOptions(): Promise<{ success: boolean; data?: { label: string; value: string }[]; error?: string }> {
  const supabase = await createServerClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { success: false, error: 'Unauthorized' }

  const accessToken = process.env.HUBSPOT_ACCESS_TOKEN
  if (!accessToken) return { success: false, error: 'Token Missing' }

  const result = await fetchHubSpotProperty('win_probability', accessToken)
  if (!result.ok) return { success: false, error: result.error }

  const options = (result.data?.options || [])
    .filter((opt: PropertyOption) => !opt.hidden)
    .map((opt: PropertyOption) => ({ label: opt.label, value: opt.value }))
  return { success: true, data: options }
}
