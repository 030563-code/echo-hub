'use server'

import { z } from 'zod'
import { revalidatePath } from 'next/cache'
import { assertDealAccess } from '@/lib/authz'
import { externalCallsDisabled, STAGING_SKIP_NOTE } from '@/lib/env'
import { HubSpotConfigError, hubspotFetch } from '@/lib/hubspot-client'
import { closeDateForHubSpot, closeDayProblem } from '@/lib/close-date'

/**
 * Move one deal's close date, from the deal page, the past-close banner or anywhere else in Quotes.
 *
 * Dean, 24 Sep 2026: "Okay add a close date field in the Hub please."
 *
 * Its own action rather than updateDealProperties, which takes any property bag: this one writes
 * closedate and nothing else, and only a real calendar day in range (close-date.ts). The same
 * deal access check as every other deal write, with quotes.create, so a view-only user cannot move
 * a date, and a rep only their own pipeline's deals.
 */

const Schema = z.object({
  dealId: z.string().trim().min(1).max(40),
  closeDay: z.string().trim(),
})

export type UpdateDealCloseDateResult = { success: true } | { success: false; error: string }

export async function updateDealCloseDate(input: { dealId: string; closeDay: string }): Promise<UpdateDealCloseDateResult> {
  const parsed = Schema.safeParse(input)
  if (!parsed.success) return { success: false, error: 'Pick a close date.' }
  const { dealId, closeDay } = parsed.data

  const problem = closeDayProblem(closeDay, Date.now())
  if (problem) return { success: false, error: problem }

  const access = await assertDealAccess(dealId, 'quotes.create')
  if (!access.ok) return { success: false, error: access.error }

  if (externalCallsDisabled()) return { success: false, error: STAGING_SKIP_NOTE }

  try {
    const res = await hubspotFetch(`https://api.hubapi.com/crm/v3/objects/deals/${dealId}`, {
      method: 'PATCH',
      body: JSON.stringify({ properties: { closedate: closeDateForHubSpot(closeDay) } }),
    })
    if (!res.ok) {
      console.error('updateDealCloseDate: HubSpot answered', res.status, await res.text().catch(() => ''))
      return { success: false, error: 'HubSpot did not take the new close date. Try again.' }
    }
  } catch (err) {
    if (err instanceof HubSpotConfigError) return { success: false, error: err.message }
    console.error('updateDealCloseDate failed', dealId, err)
    return { success: false, error: 'HubSpot did not take the new close date. Try again.' }
  }

  revalidatePath(`/quotes/deals/${dealId}`)
  // The past-close banner sits in the Quotes layout, above every tab.
  revalidatePath('/quotes', 'layout')
  return { success: true }
}
