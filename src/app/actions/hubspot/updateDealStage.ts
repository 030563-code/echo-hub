'use server'

import { assertDealAccess } from '@/lib/authz'
import { createServerClient } from '@/lib/supabase/server'
import { HUBSPOT_PIPELINES, QUOTATION_ACCEPTED_STAGES } from '@/lib/hubspot-constants'
import { DEPOT_MAPPING } from '@/lib/depot-constants'

export async function updateDealStage(dealId: string, pipelineId: string, stageId: string, sendingDepot?: string, amount?: number, tenderDate?: string) {
  // IDOR guard (finding #5): the deal must belong to the caller's pipeline.
  // This is a write path, so require quotes.create explicitly — the default
  // ('quotes.view') would let a view-only user push stage/depot/amount changes.
  const access = await assertDealAccess(dealId, 'quotes.create')
  if (!access.ok) {
    return { success: false, error: access.error }
  }

  // Post-check write guards (review finding #1): assertDealAccess only validates
  // the deal's CURRENT pipeline. Stop a non-admin from reassigning the deal into
  // a different pipeline, or stamping a depot they aren't allowed to use.
  if (!access.profile.is_super_admin) {
    if (pipelineId !== access.pipelineId) {
      return { success: false, error: 'Cannot move a deal to another pipeline' }
    }
    if (sendingDepot && !access.profile.allowed_depots.includes(sendingDepot)) {
      return { success: false, error: 'You are not permitted to use this depot' }
    }
  }

  // The sending depot is deliberately OPTIONAL everywhere upstream (quote
  // creation, earlier stages) and REQUIRED here, at the acceptance transition:
  // it's the fulfilment decision, and the accepted-quote automation (Xero/MCS)
  // silently no-ops without a valid depot on the row. UI enforces this too,
  // but server actions are directly POSTable, so the gate must live here.
  if (QUOTATION_ACCEPTED_STAGES.includes(stageId) && !sendingDepot) {
    return {
      success: false,
      error: 'A sending depot is required to mark a deal as Quotation Accepted.',
    }
  }

  // The quote may have been validated against the UNION of the caller's depots
  // (depot undecided at quote time), so the stored line items are re-checked
  // against the ONE depot chosen for fulfilment — otherwise a multi-depot rep
  // ships a Xero/MCS payload whose lines can't be mapped at the accepted depot.
  // Same stance as create-quote.ts: unmapped SKUs pass (mapping is incomplete);
  // only mapped-elsewhere-but-not-here is refused. Deals never quoted through
  // the Hub have no stored items and skip the check. Super admins bypass, as an
  // escape hatch for deliberate exceptions.
  if (
    !access.profile.is_super_admin &&
    QUOTATION_ACCEPTED_STAGES.includes(stageId) &&
    sendingDepot
  ) {
    const supabase = await createServerClient()
    const { data: regRow } = await supabase
      .from('deals_registry')
      .select('line_items_raw')
      .eq('hubspot_deal_id', dealId)
      .maybeSingle()
    const items: unknown[] = Array.isArray(regRow?.line_items_raw) ? regRow.line_items_raw : []
    const skus = Array.from(
      new Set(
        items
          .map((i) => String((i as { sku?: unknown })?.sku ?? '').trim())
          .filter(Boolean)
      )
    )
    if (skus.length > 0) {
      const { data: mapRows, error: mapError } = await supabase
        .from('product_depot_mapping')
        .select('hubspot_sku_code, depot_code')
        .eq('is_active', true)
        .in('hubspot_sku_code', skus)
      if (mapError) {
        console.error('acceptance depot revalidation failed:', mapError.message)
        return { success: false, error: 'Could not verify the quoted products for this depot. Please try again.' }
      }
      const mappedAnywhere = new Set((mapRows ?? []).map((r) => r.hubspot_sku_code))
      const allowedHere = new Set(
        (mapRows ?? []).filter((r) => r.depot_code === sendingDepot).map((r) => r.hubspot_sku_code)
      )
      const wrongDepot = skus.filter((sku) => mappedAnywhere.has(sku) && !allowedHere.has(sku))
      if (wrongDepot.length > 0) {
        return {
          success: false,
          error: `These quoted products are not available from ${sendingDepot}: ${wrongDepot.join(', ')}. Choose a different depot or update the quote first.`,
        }
      }
    }
  }

  const accessToken = process.env.HUBSPOT_ACCESS_TOKEN
  if (!accessToken) {
    return { success: false, error: 'HubSpot Access Token not configured' }
  }

  try {
    const properties: Record<string, string> = {
      dealstage: stageId,
      pipeline: pipelineId
    }

    if (sendingDepot) {
      // Map the depot code (e.g., US-BAL) to the internal name (e.g., US Baltimore)
      // If no mapping exists, use the value as is (fallback)
      const internalDepotName = DEPOT_MAPPING[sendingDepot] || sendingDepot
      properties.sending_depot = internalDepotName
    }

    if (amount !== undefined) {
      properties.amount = amount.toString()
    }

    if (tenderDate) {
      properties.tender_date = tenderDate
    }

    const response = await fetch(`https://api.hubapi.com/crm/v3/objects/deals/${dealId}`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ properties }),
      cache: 'no-store'
    })

    if (!response.ok) {
      const errorText = await response.text()
      console.error('HubSpot Update Deal Stage Error:', errorText)
      return { success: false, error: 'Failed to update deal stage in HubSpot' }
    }

    return { success: true }

  } catch (error: unknown) {
    console.error('updateDealStage Exception:', error)
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export async function getDistributorStageForPipeline(pipelineId: string): Promise<string | null> {
  // Map pipeline IDs to their "Passed to Distributor" stage ID
  // Based on the constants we defined earlier
  
  if (pipelineId === HUBSPOT_PIPELINES.USA_SALES.id) {
    return HUBSPOT_PIPELINES.USA_SALES.stages.PASSED_TO_DISTRIBUTOR
  }
  
  if (pipelineId === HUBSPOT_PIPELINES.EURO_SALES.id) {
    return HUBSPOT_PIPELINES.EURO_SALES.stages.PASSED_TO_DISTRIBUTOR
  }

  // Add other pipelines if they have a distributor stage
  // For now, only USA and EURO have explicit distributor stages defined in our constants
  
  return null
}
