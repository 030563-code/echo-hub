'use server'

import { createServerClient } from '@/lib/supabase/server'
import { hasAnyCapability } from '@/lib/authz'

interface HubSpotProduct {
  id: string
  properties: {
    name: string
    price: string
    description?: string
    hs_sku?: string
  }
}

export async function searchHubSpotProducts(query: string): Promise<{ success: boolean; data?: HubSpotProduct[]; error?: string }> {
  const supabase = await createServerClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) return { success: false, error: 'Unauthorized' }
  // APP-3: CRM-proxy read requires quotes access (closes object-level confidentiality IDOR).
  if (!(await hasAnyCapability(['quotes.view', 'quotes.create']))) {
    return { success: false, error: 'Forbidden: missing quotes capability' }
  }

  const accessToken = process.env.HUBSPOT_ACCESS_TOKEN
  if (!accessToken) return { success: false, error: 'Token Missing' }

  try {
    const response = await fetch('https://api.hubapi.com/crm/v3/objects/products/search', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        filterGroups: [
          {
            filters: [
              { propertyName: 'name', operator: 'CONTAINS_TOKEN', value: query }
            ]
          },
          {
            filters: [
              { propertyName: 'hs_sku', operator: 'CONTAINS_TOKEN', value: query }
            ]
          }
        ],
        properties: ['name', 'price', 'description', 'hs_sku'],
        limit: 20, // Fetch top 20 matches
        sorts: ['name'],
      }),
      cache: 'no-store'
    })

    if (!response.ok) {
      return { success: false, error: 'Failed to search products' }
    }

    const data = await response.json()
    return { success: true, data: data.results }

  } catch (error: unknown) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
}
