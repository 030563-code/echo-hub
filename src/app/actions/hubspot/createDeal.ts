'use server'

import { createServerClient } from '@/lib/supabase/server'
import { HUBSPOT_PIPELINES } from '@/lib/hubspot-constants'

interface CreateDealParams {
  dealName: string
  description?: string
  companyId?: string
  contactId?: string
  pipelineId?: string
  currency?: string
  winProbability?: string
}

export async function createHubSpotDeal(params: CreateDealParams): Promise<{ success: boolean; dealId?: string; error?: string }> {
  const supabase = await createServerClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) return { success: false, error: 'Unauthorized' }

  const accessToken = process.env.HUBSPOT_ACCESS_TOKEN
  if (!accessToken) return { success: false, error: 'Token Missing' }

  try {
    // 1. Get User's Default Pipeline and Team from Profile
    let pipelineId = params.pipelineId
    let hubspotTeamId = ''
    
    if (!pipelineId) {
      const { data: profile } = await supabase
        .from('profiles')
        .select('pipeline_id, hubspot_team_id')
        .eq('id', user.id)
        .maybeSingle()
      pipelineId = profile?.pipeline_id
      hubspotTeamId = profile?.hubspot_team_id
    } else {
       // If pipelineId was passed, we still need to fetch team ID
       const { data: profile } = await supabase
        .from('profiles')
        .select('hubspot_team_id')
        .eq('id', user.id)
        .maybeSingle()
       hubspotTeamId = profile?.hubspot_team_id
    }

    if (!pipelineId) {
      return { success: false, error: 'No pipeline configured for user' }
    }

    // 2. Determine Stage (Quote Request)
    let stageId = ''
    let ownerId = ''

    // Fetch Owner ID for current user
    try {
      const ownerResponse = await fetch(
        `https://api.hubapi.com/crm/v3/owners/?email=${encodeURIComponent(user.email || '')}`,
        {
          headers: { Authorization: `Bearer ${accessToken}` },
          cache: 'no-store',
        }
      )
      if (ownerResponse.ok) {
        const ownerData = await ownerResponse.json()
        ownerId = ownerData.results?.[0]?.id
      }
    } catch (e) {
      console.error('Failed to fetch owner ID', e)
    }

    // Try to find the correct Quote Request stage for the pipeline from constants
    let pipelineFound = false
    for (const key in HUBSPOT_PIPELINES) {
      const pipeline = HUBSPOT_PIPELINES[key as keyof typeof HUBSPOT_PIPELINES]
      if (pipeline.id === pipelineId) {
        pipelineFound = true
        // Look for a stage key that indicates a quote request or initial stage
        const stageKey = Object.keys(pipeline.stages).find(k => 
          k.includes('QUOTE_REQUEST') || 
          k.includes('REQUEST_A_QUOTE') || 
          k.includes('CUSTOMER_REQUESTED_QUOTATION') ||
          k.includes('LEAD') ||
          k.includes('NEW_ENQUIRY')
        )
        
        if (stageKey) {
          stageId = pipeline.stages[stageKey as keyof typeof pipeline.stages]
          break
        }
      }
    }

    // If pipeline not found in constants or no stage found, fetch from HubSpot API
    if (!stageId) {
      try {
        const pipelineResponse = await fetch(`https://api.hubapi.com/crm/v3/pipelines/deals/${pipelineId}`, {
          headers: { Authorization: `Bearer ${accessToken}` },
          cache: 'no-store'
        })
        
        if (pipelineResponse.ok) {
          const pipelineData = await pipelineResponse.json()
          // Use the first stage in the pipeline
          if (pipelineData.stages && pipelineData.stages.length > 0) {
            stageId = pipelineData.stages[0].id
          }
        }
      } catch (e) {
        console.error('Failed to fetch pipeline details', e)
      }
    }

    // Fallback if everything fails (this might still fail if pipeline ID is totally wrong)
    if (!stageId) {
       // If we still don't have a stage ID, we can't create the deal safely.
       // But if the user insists on a fallback, we can try the USA one, but it failed before.
       // Let's try to be smarter. If the pipeline ID matches USA, force the USA stage.
       if (pipelineId === 'dfc85d9e-7eb9-4ade-a9cf-4e726cbcc9cc') {
          stageId = '3f5e750b-c1cb-46b6-aa8e-cbed58d0b94c'
       } else {
          // If we really can't find it, we might need to return an error or let HubSpot default (by omitting dealstage? No, it's usually required)
          // Let's try omitting dealstage if we can't find one, maybe HubSpot picks the default for the pipeline.
          // But the API usually requires it.
          // Let's log this critical failure.
          console.error(`Could not determine stage for pipeline ${pipelineId}`)
          return { success: false, error: `Could not determine valid stage for pipeline ${pipelineId}` }
       }
    }

    // 3. Create Deal
    const response = await fetch('https://api.hubapi.com/crm/v3/objects/deals', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        properties: {
          dealname: params.dealName,
          description: params.description,
          pipeline: pipelineId,
          dealstage: stageId,
          amount: '0',
          hubspot_owner_id: ownerId, // Assign owner to set team
          deal_currency_code: params.currency || 'USD',
          ...(params.winProbability ? { win_probability: params.winProbability } : {}),
        },
        associations: [
          ...(params.companyId ? [{
            to: { id: params.companyId },
            types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 5 }] // Deal to Company
          }] : []),
          ...(params.contactId ? [{
            to: { id: params.contactId },
            types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 3 }] // Deal to Contact
          }] : [])
        ]
      }),
      cache: 'no-store'
    })

    if (!response.ok) {
      const errorText = await response.text()
      console.error('HubSpot create deal error:', errorText)
      return { success: false, error: 'Failed to create deal. Please try again.' }
    }

    const data = await response.json()
    return { success: true, dealId: data.id }

  } catch (error: unknown) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
}
