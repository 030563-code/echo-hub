'use server'

import { z } from 'zod'
import { revalidatePath } from 'next/cache'
import { assertDealAccess } from '@/lib/authz'
import { getDealDetails } from '@/app/actions/hubspot/getDealDetails'
import { updateDealStage } from '@/app/actions/hubspot/updateDealStage'
import { updateDealProperties } from '@/app/actions/hubspot/updateDealProperties'
import { createDealNote } from '@/app/actions/hubspot/createDealNote'
import { closedLostStageFor } from '@/lib/deals-board'

/**
 * Closing a deal because the customer is buying through a contractor.
 *
 * Dean's words: "a deal would open up from lets say ABC company and the
 * original deal is created under ABC company but if the deal is then contracted
 * through United Rentals or a contractor for example the sales people should
 * really be able to then in this case go to the ABC company deal and have the
 * ability to go Deal assigned to contractor, then that specific deal gets set
 * to closed lost with the notes."
 *
 * The reason field is the fixed phrase and the rep's note carries the detail,
 * which is what Dean asked for: a reporting filter that actually groups, with
 * the specifics where a person will read them.
 *
 * Writes go to HubSpot only. deals_registry is deliberately untouched: n8n
 * already syncs a dealstage change into deal_status, and a second writer on
 * that table risks re-firing the accepted-quote pipeline through its AFTER
 * trigger.
 */

const REASON = 'Assigned to Contractor'

const Schema = z.object({
  dealId: z.string().trim().regex(/^\d+$/),
  note: z.string().trim().min(1, 'Say which contractor and anything the team should know').max(2000),
})

export type AssignResult =
  | { success: true; noteWritten: boolean }
  | { success: false; error: string }

export async function assignDealToContractor(input: {
  dealId: string
  note: string
}): Promise<AssignResult> {
  const parsed = Schema.safeParse(input)
  if (!parsed.success) return { success: false, error: parsed.error.issues[0]?.message ?? 'Invalid input' }
  const { dealId, note } = parsed.data

  const access = await assertDealAccess(dealId, 'quotes.create')
  if (!access.ok) return { success: false, error: access.error }

  const { data: deal } = await getDealDetails(dealId)
  const pipelineId = deal?.properties?.pipeline
  if (!pipelineId) {
    return { success: false, error: 'Could not read this deal from HubSpot, so nothing was changed.' }
  }

  const closedLostStageId = closedLostStageFor(pipelineId)
  if (!closedLostStageId) {
    return {
      success: false,
      error: 'This pipeline has no single Closed Lost stage, so the Hub will not guess one. Close the deal in HubSpot instead.',
    }
  }

  // Reason first, stage second, so n8n's stage sync sees a deal that already
  // carries its reason rather than one that acquires it a moment later.
  const reason = await updateDealProperties(dealId, { closed_lost_reason: `${REASON}: ${note}` })
  if (!reason.success) {
    return { success: false, error: reason.error ?? 'Could not write the reason to HubSpot.' }
  }

  const staged = await updateDealStage(dealId, pipelineId, closedLostStageId)
  if (!staged.success) {
    // The reason is on the deal but the stage is not, which is visible and
    // recoverable. Say so rather than implying nothing happened.
    return {
      success: false,
      error: `The reason was saved but the deal could not be closed: ${staged.error ?? 'HubSpot refused the stage change'}. Try again.`,
    }
  }

  // Best-effort: the deal is already closed and carries its reason, so a failed
  // note is worth reporting but not worth undoing anything for.
  const noted = await createDealNote(dealId, `${REASON}. ${note}`)
  if (!noted.success) console.error('assignDealToContractor note failed', noted.error)

  revalidatePath(`/quotes/deals/${dealId}`)
  return { success: true, noteWritten: noted.success }
}
