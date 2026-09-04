'use server'

import { assertDealAccess } from '@/lib/authz'

/**
 * Write ONLY the HubSpot deal's amount.
 *
 * Republishing an edited quote used to leave the deal carrying the first
 * version's total forever: the deal amount is written in exactly one place,
 * updateDealStage, and only createQuote ever passes it. Dean's deal read $100
 * in HubSpot while the quote the customer could see read $1,000.
 *
 * Deliberately NOT updateDealStage. That action always PATCHes `dealstage` and
 * `pipeline` alongside whatever else it is given, so calling it to correct an
 * amount would stamp a stage too, and a deal moved in HubSpot while the quote
 * was open for editing would be silently snapped back.
 *
 * Deliberately NOT updateDealProperties either: that one blocks `amount` on
 * purpose, because it is the generic caller-supplies-the-properties action and
 * the total has to stay a server-recomputed figure. This action takes a number,
 * never a property bag, so there is nothing for a caller to smuggle in.
 *
 * The accepted-deal question is settled upstream, not here. republishEditedQuote
 * refuses to resync a deal that has reached Quotation Accepted, so a repriced
 * amount can never reach an accepted deal and re-fire the Xero quote or the MCS
 * contract. Do not call this from a path that lacks that check.
 */
export async function updateDealAmount(
  dealId: string,
  amount: number,
): Promise<{ success: boolean; error?: string }> {
  // A write path, so quotes.create rather than the quotes.view default.
  const access = await assertDealAccess(dealId, 'quotes.create')
  if (!access.ok) return { success: false, error: access.error }

  if (!Number.isFinite(amount) || amount < 0) {
    return { success: false, error: 'Refusing to write a deal amount that is not a positive number' }
  }

  const accessToken = process.env.HUBSPOT_ACCESS_TOKEN
  if (!accessToken) return { success: false, error: 'HubSpot Access Token not configured' }

  try {
    const response = await fetch(`https://api.hubapi.com/crm/v3/objects/deals/${dealId}`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ properties: { amount: amount.toString() } }),
      cache: 'no-store',
    })

    if (!response.ok) {
      const errorText = await response.text()
      console.error('HubSpot Update Deal Amount Error:', errorText)
      return { success: false, error: 'Failed to update the deal amount in HubSpot' }
    }

    return { success: true }
  } catch (error: unknown) {
    console.error('updateDealAmount Exception:', error)
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
}
