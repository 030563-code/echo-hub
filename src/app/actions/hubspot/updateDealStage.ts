'use server'

import { assertDealAccess } from '@/lib/authz'
import { HUBSPOT_PIPELINES } from '@/lib/hubspot-constants'
import { DEPOT_MAPPING } from '@/lib/depot-constants'

export async function updateDealStage(dealId: string, pipelineId: string, stageId: string, sendingDepot?: string, amount?: number, tenderDate?: string) {
  // IDOR guard (finding #5): the deal must belong to the caller's pipeline.
  const access = await assertDealAccess(dealId)
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
