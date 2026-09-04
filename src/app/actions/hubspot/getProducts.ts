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

export async function getHubSpotProducts(): Promise<{ success: boolean; data?: HubSpotProduct[]; error?: string }> {
  const supabase = await createServerClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    return { success: false, error: 'User not authenticated' }
  }
  // APP-3: CRM-proxy read requires quotes access, or pricing access.
  //
  // The pricing screens need this catalogue: /pricing/list drives its SKU
  // picker from it, and /pricing/contracts reads product names from it for
  // customer-specific SKUs that are on no general price list. Without pricing
  // here, a pure pricing admin saw an empty picker and bare SKUs on their own
  // page. Same read, same data, wider list of capabilities that reach it.
  if (!(await hasAnyCapability(['quotes.view', 'quotes.create', 'pricing.view', 'pricing.manage']))) {
    return { success: false, error: 'Forbidden: needs quotes or pricing access' }
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
