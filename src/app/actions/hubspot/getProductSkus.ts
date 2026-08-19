'use server'

import { createServerClient } from '@/lib/supabase/server'
import { hasAnyCapability } from '@/lib/authz'

/**
 * Server-side product -> SKU resolution. Used by createQuote to derive hs_sku
 * authoritatively from HubSpot rather than trusting client-supplied li.sku,
 * which a crafted request could omit/blank to smuggle a restricted product
 * through via productId alone (the depot-eligibility check keys on SKU).
 */
export async function getProductSkus(productIds: string[]): Promise<{ success: boolean; data?: Record<string, string>; error?: string }> {
  if (productIds.length === 0) return { success: true, data: {} }

  const supabase = await createServerClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    return { success: false, error: 'User not authenticated' }
  }
  // APP-3: CRM-proxy read requires quotes access.
  if (!(await hasAnyCapability(['quotes.view', 'quotes.create']))) {
    return { success: false, error: 'Forbidden: missing quotes capability' }
  }

  const accessToken = process.env.HUBSPOT_ACCESS_TOKEN
  if (!accessToken) {
    return { success: false, error: 'HubSpot Access Token not configured' }
  }

  try {
    const response = await fetch('https://api.hubapi.com/crm/v3/objects/products/batch/read', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        properties: ['hs_sku'],
        inputs: productIds.map(id => ({ id })),
      }),
      cache: 'no-store',
    })

    if (!response.ok) {
      const errorText = await response.text()
      console.error('HubSpot Batch Read Products Error:', errorText)
      return { success: false, error: 'Failed to fetch product SKUs' }
    }

    const data = await response.json()
    const skuMap: Record<string, string> = {}
    for (const product of data.results ?? []) {
      if (product?.properties?.hs_sku) {
        skuMap[product.id] = product.properties.hs_sku
      }
    }

    return { success: true, data: skuMap }

  } catch (error: unknown) {
    console.error('getProductSkus Exception:', error)
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
}
