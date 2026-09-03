'use server'

import { assertDealAccess } from '@/lib/authz'

interface LineItem {
  productId: string
  name: string
  quantity: number
  /** The BASE price, before any discount. HubSpot derives the line amount from
   *  price and its own discount property, so sending the net here as well would
   *  discount it twice. */
  unitPrice: number
  total: number
  sku?: string
  description?: string
  /** Exactly one of these, never both: HubSpot applies both when both are set
   *  and the customer sees a doubly discounted line. */
  discountPercentage?: number
  discountPerUnit?: number
}

export async function addLineItemsToDeal(dealId: string, lineItems: LineItem[], currency?: string) {
  // IDOR guard (finding #5): the deal must belong to the caller's pipeline.
  // quotes.create, not the view default — this action ARCHIVES the deal's
  // existing line items before writing the replacement set.
  const access = await assertDealAccess(dealId, 'quotes.create')
  if (!access.ok) {
    return { success: false, error: access.error }
  }

  const accessToken = process.env.HUBSPOT_ACCESS_TOKEN
  if (!accessToken) {
    return { success: false, error: 'HubSpot Access Token not configured' }
  }

  const currencyCode = String(currency ?? '').trim().toUpperCase()

  try {
    // 1. Fetch the deal's CURRENT line-item associations. Generate must be
    // idempotent — a retry after partial failure, or a page-refresh-and-regenerate,
    // must not duplicate line items on the live deal — so the new set REPLACES
    // whatever is already attached instead of appending to it. That includes
    // items added directly in HubSpot: the builder seeds its cart from the
    // deal's current items, so the cart IS the intended full state. Requesting both
    // singular and plural association keys to be safe (mirrors getDealDetails.ts;
    // HubSpot's key naming here is inconsistent).
    const dealResponse = await fetch(
      `https://api.hubapi.com/crm/v3/objects/deals/${dealId}?associations=line_item,line_items`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        cache: 'no-store',
      }
    )

    if (!dealResponse.ok) {
      const errorText = await dealResponse.text()
      console.error('HubSpot Get Deal Associations Error:', errorText)
      return { success: false, error: 'Failed to read existing line items for this deal' }
    }

    const dealData = await dealResponse.json()
    const existingRefs: { id: string }[] = [
      ...(dealData?.associations?.line_item?.results ?? []),
      ...(dealData?.associations?.line_items?.results ?? []),
    ]
    const existingIds = Array.from(new Set(existingRefs.map((r) => r.id)))

    // 2. Archive the existing line items so the deal's line-item state is fully
    // replaced by what we're about to create — no-op when there are none.
    if (existingIds.length > 0) {
      const batchArchiveResponse = await fetch('https://api.hubapi.com/crm/v3/objects/line_items/batch/archive', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          inputs: existingIds.map(id => ({ id })),
        }),
        cache: 'no-store',
      })

      if (!batchArchiveResponse.ok) {
        const errorText = await batchArchiveResponse.text()
        console.error('HubSpot Batch Archive Line Items Error:', errorText)
        return { success: false, error: 'Failed to remove existing line items before replacing them' }
      }
    }

    // 3. Batch create all line items in a single API call
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
            description: item.description,
            // Named explicitly rather than inherited: an unattached line item
            // falls back to the portal's company currency, which is EUR on this
            // account, so a USD deal would carry EUR lines.
            ...(currencyCode ? { hs_line_item_currency_code: currencyCode } : {}),
            // Percentage wins when both arrive, which is what the builder's own
            // control produces. They are never sent together.
            ...(item.discountPercentage && item.discountPercentage > 0
              ? { hs_discount_percentage: String(item.discountPercentage) }
              : item.discountPerUnit && item.discountPerUnit > 0
                ? { discount: item.discountPerUnit.toFixed(2) }
                : {}),
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

    // 4. Batch associate all line items with the deal in a single API call
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

    // Batch create preserves input order, so caller can zip these back onto
    // the items it sent — deals_registry stores them as hs_line_item_id.
    return { success: true, lineItemIds: createdIds }

  } catch (error: unknown) {
    console.error('addLineItemsToDeal Exception:', error)
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
}
