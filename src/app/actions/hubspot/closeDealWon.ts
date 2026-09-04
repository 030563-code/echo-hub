'use server'

import { assertDealAccess } from '@/lib/authz'
import { HUBSPOT_PIPELINES, CLOSED_WON_STAGES } from '@/lib/hubspot-constants'

/**
 * Move a deal to Closed won, once its invoice is on the Xero ledger.
 *
 * Called from Send to Xero, at the point Dean decided the deal is actually
 * done: quoted, accepted, invoiced, the document emailed to the customer and an
 * AUTHORISED invoice on the books.
 *
 * Deliberately NOT updateDealStage. That action always writes deals_registry as
 * part of an acceptance, and deals_registry has an AFTER trigger,
 * notify_quote_accepted(), that fires on a change to amount, line_items_raw,
 * depot_code or deal_status and raises a Xero quote and an MCS contract. Firing
 * it from the invoicing path would raise a SECOND set of documents for a deal
 * that has just been invoiced. This writes HubSpot and nothing else.
 *
 * It also carries none of updateDealStage's acceptance gate: that gate demands
 * a sending depot and a delivery address, neither of which is the invoicing
 * path's to supply, and both of which were already settled at acceptance.
 */
export async function closeDealWon(
  dealId: string,
): Promise<{ success: boolean; error?: string; alreadyWon?: boolean }> {
  // A write path, so quotes.create rather than the quotes.view default. The
  // caller has already passed invoicing.manage; this is the deal-scope check.
  const access = await assertDealAccess(dealId, 'quotes.create')
  if (!access.ok) return { success: false, error: access.error }

  const accessToken = process.env.HUBSPOT_ACCESS_TOKEN
  if (!accessToken) return { success: false, error: 'HubSpot Access Token not configured' }

  // Which "won" stage depends on the pipeline. Only the pipelines the Hub
  // actually invoices are mapped: guessing a stage id for a pipeline nobody has
  // verified would move a deal into a stage that may not exist, and HubSpot
  // answers that with a 400 rather than a no-op.
  const stageByPipeline: Record<string, string> = {
    [HUBSPOT_PIPELINES.USA_SALES.id]: HUBSPOT_PIPELINES.USA_SALES.stages.CLOSED_WON,
    [HUBSPOT_PIPELINES.EURO_SALES.id]: HUBSPOT_PIPELINES.EURO_SALES.stages.CLOSED_WON,
  }

  try {
    // One read, for two things: the stage the deal is on now, and the pipeline
    // it belongs to.
    //
    // THE PIPELINE MUST NOT COME FROM assertDealAccess. That function
    // short-circuits for a super admin and returns pipelineId null, because a
    // super admin needs no pipeline scope check. Reading it from there meant
    // every close attempted by a super admin resolved no stage and gave up with
    // "no Closed won stage is mapped for this deal's pipeline (unknown)". Dean
    // and Dave are both super admins, so closing a deal won had never once
    // worked from Send to Xero or from Reconcile. HubSpot is asked directly,
    // which is correct for every caller rather than only the ones whose scope
    // check happened to look the deal up.
    const current = await fetch(
      `https://api.hubapi.com/crm/v3/objects/deals/${dealId}?properties=dealstage,pipeline`,
      { headers: { Authorization: `Bearer ${accessToken}` }, cache: 'no-store' },
    )
    if (!current.ok) {
      return { success: false, error: `could not read the deal from HubSpot (HTTP ${current.status})` }
    }
    const body = (await current.json()) as { properties?: { dealstage?: string; pipeline?: string } }

    // A deal a human already closed is left alone rather than re-stamped. A
    // redundant PATCH would move the stage's timestamp and fire whatever
    // watches deal stage changes for a second time.
    const stage = String(body.properties?.dealstage ?? '')
    if (CLOSED_WON_STAGES.includes(stage)) return { success: true, alreadyWon: true }

    // access.pipelineId is the fallback, not the source: it is populated only
    // for a non-super-admin, where it has already been verified in scope.
    const pipelineId = String(body.properties?.pipeline ?? '') || (access.pipelineId ?? '')
    const stageId = stageByPipeline[pipelineId]
    if (!stageId) {
      return {
        success: false,
        error: `no Closed won stage is mapped for this deal's pipeline (${pipelineId || 'unknown'})`,
      }
    }

    const response = await fetch(`https://api.hubapi.com/crm/v3/objects/deals/${dealId}`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      // dealstage alone. The pipeline is not sent: the deal is already in it,
      // and writing it back would let a stale read move the deal between
      // pipelines.
      body: JSON.stringify({ properties: { dealstage: stageId } }),
      cache: 'no-store',
    })

    if (!response.ok) {
      const errorText = await response.text()
      console.error('closeDealWon HubSpot error', errorText)
      return { success: false, error: `HTTP ${response.status}` }
    }

    return { success: true }
  } catch (error: unknown) {
    console.error('closeDealWon exception', error)
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
}
