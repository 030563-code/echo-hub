'use server'

import { createServerClient } from '@/lib/supabase/server'
import { hasAnyCapability } from '@/lib/authz'

interface HubSpotLineItem {
  id: string
  properties: {
    name: string
    quantity: string
    price: string
    amount: string
    hs_product_id: string
    hs_sku?: string
  }
}

export async function getLineItems(lineItemIds: string[]): Promise<{ success: boolean; data?: HubSpotLineItem[]; error?: string }> {
  const supabase = await createServerClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) return { success: false, error: 'Unauthorized' }

  // Module capability gate — object-level reads require quotes access.
  if (!(await hasAnyCapability(['quotes.view', 'quotes.create']))) {
    return { success: false, error: 'Forbidden: missing quotes capability' }
  }

  const accessToken = process.env.HUBSPOT_ACCESS_TOKEN
  if (!accessToken) return { success: false, error: 'Token Missing' }

  try {
    // Batch read line items
    const response = await fetch('https://api.hubapi.com/crm/v3/objects/line_items/batch/read', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        inputs: lineItemIds.map(id => ({ id })),
        properties: ['name', 'quantity', 'price', 'amount', 'hs_product_id', 'hs_sku']
      }),
      cache: 'no-store'
    })

    if (!response.ok) {
      return { success: false, error: 'Failed to fetch line items' }
    }

    const data = await response.json()
    const lineItems: HubSpotLineItem[] = data.results

    // Collect unique product IDs that need SKU lookup
    const productIds = lineItems
      .map((item: HubSpotLineItem) => item.properties.hs_product_id)
      .filter(Boolean)

    // Build a SKU map via a single batch read of all products
    const skuMap: Record<string, string> = {}
    if (productIds.length > 0) {
      try {
        const batchResponse = await fetch('https://api.hubapi.com/crm/v3/objects/products/batch/read', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            inputs: productIds.map((id: string) => ({ id })),
            properties: ['hs_sku'],
          }),
          cache: 'no-store',
        })

        if (batchResponse.ok) {
          const batchData = await batchResponse.json()
          for (const product of batchData.results) {
            if (product.properties?.hs_sku) {
              skuMap[product.id] = product.properties.hs_sku
            }
          }
        }
      } catch (e) {
        console.error('Failed to batch fetch product SKUs', e)
      }
    }

    // Enrich line items with SKU from the map
    const enrichedLineItems: HubSpotLineItem[] = lineItems.map((item: HubSpotLineItem) => {
      const sku = skuMap[item.properties.hs_product_id]
      if (sku) {
        return { ...item, properties: { ...item.properties, hs_sku: sku } }
      }
      return item
    })

    return { success: true, data: enrichedLineItems }

  } catch (error: unknown) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
}
