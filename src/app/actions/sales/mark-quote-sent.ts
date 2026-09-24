'use server'

/**
 * Move a deal to Quotation sent, when the rep says they have actually sent it.
 *
 * createQuote used to do this itself, three steps before the quote existed: the
 * move ran BEFORE the line items were attached and before the HubSpot quote was
 * published, so a deal claimed a quote had gone out while it was still being
 * assembled, and claimed it again if a later step failed. Jillian reported it
 * from the other side: "once the deal is made it says that the quote has been
 * sent but it hasn't".
 *
 * The Hub cannot see the send when it happens. It opens a prefilled Gmail
 * compose window and nothing leaves until the rep presses Send there, in
 * another tab. So the rep can say so here, straight away. Since 24 Sep 2026 the
 * Hub also finds the send afterwards, once HubSpot has logged the email with the
 * quote link in it (src/lib/quote-sent), and moves the deal itself.
 */

import { z } from 'zod'
import { assertDealAccess } from '@/lib/authz'
import { externalCallsDisabled, STAGING_SKIP_NOTE } from '@/lib/env'
import {
  QUOTATION_SENT_STAGES,
  QUOTATION_ACCEPTED_STAGES,
  CLOSED_WON_STAGES,
  CLOSED_LOST_STAGES,
} from '@/lib/hubspot-constants'
import { quotationSentStageFor } from '@/lib/quote-sent/stage'

const Input = z.object({ dealId: z.string().min(1).max(64) })

export type MarkQuoteSentResult =
  | { success: true; alreadyBeyond?: boolean }
  | { success: false; error: string }

export async function markQuoteSent(input: { dealId: string }): Promise<MarkQuoteSentResult> {
  const parsed = Input.safeParse(input)
  if (!parsed.success) return { success: false, error: 'Invalid deal id' }
  const { dealId } = parsed.data

  // A write, so quotes.create rather than the quotes.view default.
  const access = await assertDealAccess(dealId, 'quotes.create')
  if (!access.ok) return { success: false, error: access.error }

  const accessToken = process.env.HUBSPOT_ACCESS_TOKEN
  if (!accessToken) return { success: false, error: 'HubSpot Access Token not configured' }

  try {
    // The pipeline comes from HubSpot, never from assertDealAccess: that
    // short-circuits for a super admin and hands back pipelineId null, which is
    // exactly how closeDealWon silently did nothing for months.
    const current = await fetch(
      `https://api.hubapi.com/crm/v3/objects/deals/${dealId}?properties=dealstage,pipeline`,
      { headers: { Authorization: `Bearer ${accessToken}` }, cache: 'no-store' },
    )
    if (!current.ok) {
      return { success: false, error: `could not read the deal from HubSpot (HTTP ${current.status})` }
    }
    const body = (await current.json()) as { properties?: { dealstage?: string; pipeline?: string } }
    const stage = String(body.properties?.dealstage ?? '')

    // Never drag a deal BACKWARDS. A quote re-sent on a deal the customer has
    // already accepted, won or lost must not reopen it, and marking one that is
    // already at Quotation sent should say so rather than re-stamp the stage.
    if (
      QUOTATION_SENT_STAGES.includes(stage) ||
      QUOTATION_ACCEPTED_STAGES.includes(stage) ||
      CLOSED_WON_STAGES.includes(stage) ||
      CLOSED_LOST_STAGES.includes(stage)
    ) {
      return { success: true, alreadyBeyond: true }
    }

    const pipelineId = String(body.properties?.pipeline ?? '') || (access.pipelineId ?? '')
    const stageId = quotationSentStageFor(pipelineId)
    if (!stageId) {
      return {
        success: false,
        error: `no Quotation sent stage is mapped for this deal's pipeline (${pipelineId || 'unknown'})`,
      }
    }

    // Staging kill switch. This action PATCHes HubSpot with a raw fetch rather than
    // through hubspotFetch, so the client's central block never sees it and the
    // guard has to be here. Sits after the access check so it cannot mask one.
    if (externalCallsDisabled()) return { success: false, error: STAGING_SKIP_NOTE }

    // dealstage alone. The pipeline is not written back: the deal is already in
    // it, and sending it would let a stale read move the deal between pipelines.
    const response = await fetch(`https://api.hubapi.com/crm/v3/objects/deals/${dealId}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ properties: { dealstage: stageId } }),
      cache: 'no-store',
    })
    if (!response.ok) {
      console.error('markQuoteSent HubSpot error', await response.text())
      return { success: false, error: `HTTP ${response.status}` }
    }

    return { success: true }
  } catch (error: unknown) {
    console.error('markQuoteSent exception', error)
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
}
