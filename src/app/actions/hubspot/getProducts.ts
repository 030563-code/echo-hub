'use server'

import { createServerClient } from '@/lib/supabase/server'

interface HubSpotProduct {
  id: string
  properties: {
    name: string
    price: string
    description?: string
    hs_sku?: string
  }
}

export async function getHubSpotProducts(): Promise<{ success: boolean; data?: HubSpotProduct[]; error?: string }> {
  const supabase = await createServerClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    return { success: false, error: 'User not authenticated' }
  }

  const accessToken = process.env.HUBSPOT_ACCESS_TOKEN
  if (!accessToken) {
    return { success: false, error: 'HubSpot Access Token not configured' }
  }

  try {
    let allProducts: HubSpotProduct[] = []
    let after: string | undefined = undefined
    let hasMore = true

    while (hasMore) {
      const url = new URL('https://api.hubapi.com/crm/v3/objects/products')
      url.searchParams.append('properties', 'name,price,description,hs_sku')
      url.searchParams.append('limit', '100')
      if (after) {
        url.searchParams.append('after', after)
      }

      const response = await fetch(url.toString(), {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        cache: 'no-store',
      })

      if (!response.ok) {
        const errorText = await response.text()
        console.error('HubSpot Products API Error:', errorText)
        return { success: false, error: 'Failed to fetch products' }
      }

      const data = await response.json()
      allProducts = [...allProducts, ...data.results]

      if (data.paging?.next?.after) {
        after = data.paging.next.after
      } else {
        hasMore = false
      }
    }

    return { success: true, data: allProducts }

  } catch (error: unknown) {
    console.error('getHubSpotProducts Exception:', error)
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
}
