'use server'

import { assertDealAccess } from '@/lib/authz'

interface LineItem {
  productId: string
  name: string
  quantity: number
  unitPrice: number
  total: number
  sku?: string
}

export async function addLineItemsToDeal(dealId: string, lineItems: LineItem[]) {
  // IDOR guard (finding #5): the deal must belong to the caller's pipeline.
  const access = await assertDealAccess(dealId)
  if (!access.ok) {
    return { success: false, error: access.error }
  }

  const accessToken = process.env.HUBSPOT_ACCESS_TOKEN
  if (!accessToken) {
    return { success: false, error: 'HubSpot Access Token not configured' }
  }

  try {
    // 1. Batch create all line items in a single API call
    const batchCreateResponse = await fetch('https://api.hubapi.com/crm/v3/objects/line_items/batch/create', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        inputs: lineItems.map(item => ({
          properties: {
            name: item.name,
            quantity: item.quantity.toString(),
            price: item.unitPrice.toString(),
            hs_product_id: item.productId,
            hs_sku: item.sku,
          },
        })),
      }),
      cache: 'no-store',
    })

    if (!batchCreateResponse.ok) {
      const errorText = await batchCreateResponse.text()
      console.error('HubSpot Batch Create Line Items Error:', errorText)
      return { success: false, error: 'Failed to batch create line items' }
    }

    const batchCreateData = await batchCreateResponse.json()
    const createdIds: string[] = batchCreateData.results.map((r: { id: string }) => r.id)

    // 2. Batch associate all line items with the deal in a single API call
    const batchAssocResponse = await fetch('https://api.hubapi.com/crm/v4/associations/line_items/deals/batch/create', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        inputs: createdIds.map(lineItemId => ({
          from: { id: lineItemId },
          to: { id: dealId },
          types: [
            {
              associationCategory: 'HUBSPOT_DEFINED',
              associationTypeId: 20,
            },
          ],
        })),
      }),
      cache: 'no-store',
    })

    if (!batchAssocResponse.ok) {
      const err = await batchAssocResponse.text()
      console.error('HubSpot Batch Associate Line Items Error:', err)
      return { success: false, error: 'Failed to associate line items with deal' }
    }

    return { success: true }

  } catch (error: unknown) {
    console.error('addLineItemsToDeal Exception:', error)
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
}
