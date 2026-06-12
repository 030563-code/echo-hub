'use server'

import { assertDealAccess } from '@/lib/authz'

// Properties an agent must never set directly via this generic action.
// dealstage/pipeline go through updateDealStage; ownership/amount are not
// agent-editable. (finding #5)
const BLOCKED_PROPERTIES = new Set([
  'hubspot_owner_id',
  'hs_owner_id',
  'dealstage',
  'pipeline',
])

export async function updateDealProperties(
  dealId: string,
  properties: Record<string, string>
): Promise<{ success: boolean; error?: string }> {
  // IDOR guard (finding #5): the deal must belong to the caller's pipeline.
  const access = await assertDealAccess(dealId)
  if (!access.ok) return { success: false, error: access.error }

  const blocked = Object.keys(properties).filter((k) => BLOCKED_PROPERTIES.has(k))
  if (blocked.length > 0) {
    return { success: false, error: `Cannot update protected properties: ${blocked.join(', ')}` }
  }

  const accessToken = process.env.HUBSPOT_ACCESS_TOKEN
  if (!accessToken) return { success: false, error: 'Token Missing' }

  try {
    const response = await fetch(`https://api.hubapi.com/crm/v3/objects/deals/${dealId}`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ properties }),
      cache: 'no-store',
    })

    if (!response.ok) {
      const errorText = await response.text()
      console.error('HubSpot Update Deal Properties Error:', errorText)
      return { success: false, error: 'Failed to update deal properties in HubSpot' }
    }

    return { success: true }
  } catch (error: unknown) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
}
