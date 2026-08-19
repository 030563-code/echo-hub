'use server'

import { assertDealAccess } from '@/lib/authz'

// Properties an agent must never set directly via this generic action.
// dealstage/pipeline go through updateDealStage; ownership/amount are not
// agent-editable. sending_depot and amount are also blocked here — they must
// only be set via updateDealStage / createQuote, which enforce the depot
// allow-list and server-side total recompute respectively. (finding #5)
const BLOCKED_PROPERTIES = new Set([
  'hubspot_owner_id',
  'hs_owner_id',
  'dealstage',
  'pipeline',
  'sending_depot',
  'amount',
])

export async function updateDealProperties(
  dealId: string,
  properties: Record<string, string>
): Promise<{ success: boolean; error?: string }> {
  // IDOR guard (finding #5): the deal must belong to the caller's pipeline.
  // This is a write path, so require quotes.create explicitly — the default
  // ('quotes.view') would let a view-only user edit deal properties.
  const access = await assertDealAccess(dealId, 'quotes.create')
  if (!access.ok) return { success: false, error: access.error }

  const blocked = Object.keys(properties).filter((k) => BLOCKED_PROPERTIES.has(k.trim().toLowerCase()))
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
