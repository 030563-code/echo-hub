'use server'

import { assertDealAccess } from '@/lib/authz'
import { createServerClient } from '@/lib/supabase/server'
import { HUBSPOT_PIPELINES, QUOTATION_ACCEPTED_STAGES } from '@/lib/hubspot-constants'
import { DEPOT_MAPPING } from '@/lib/depot-constants'
import { isUSDepot } from '@/lib/customer-invoice/constants'
import { sanitizeUSAddress, type USDeliveryAddress } from '@/lib/us-address'
import { parseWinProbability } from '@/lib/quote-math'

export interface AcceptanceExtras {
  /** HubSpot win_probability option value ('10%'..'100%'). Written to HubSpot
   *  and deals_registry when provided. */
  winProbability?: string
  /** US delivery (ship-to) address, captured at acceptance for TaxJar. */
  delivery?: Partial<USDeliveryAddress>
}

export async function updateDealStage(dealId: string, pipelineId: string, stageId: string, sendingDepot?: string, amount?: number, tenderDate?: string, acceptance?: AcceptanceExtras) {
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

  // US acceptance gate: a US dispatch depot means this deal enters the US
  // invoicing flow (destination-based sales tax via TaxJar), so a complete
  // delivery address, a probability of close, and an associated company are
  // mandatory BEFORE the stage moves. Keyed on the depot, not the pipeline:
  // CA-HAM and EU acceptances keep the depot-only requirement above. The
  // registry write happens BEFORE the HubSpot PATCH so the row is already
  // complete when the acceptance echoes back into the admin queue (and a
  // failed PATCH leaves nothing worse than a saved address).
  const parsedProbability = parseWinProbability(acceptance?.winProbability)
  if (QUOTATION_ACCEPTED_STAGES.includes(stageId) && isUSDepot(sendingDepot)) {
    // 1) The deal must have an associated company (the invoice customer).
    const assocRes = await fetch(
      `https://api.hubapi.com/crm/v3/objects/deals/${dealId}?properties=dealname&associations=companies`,
      { headers: { Authorization: `Bearer ${accessToken}` }, cache: 'no-store' },
    )
    if (!assocRes.ok) {
      return { success: false, error: 'Could not verify the deal in HubSpot. Please try again.' }
    }
    const assocBody = (await assocRes.json()) as {
      associations?: { companies?: { results?: unknown[] } }
    }
    if (!assocBody.associations?.companies?.results?.length) {
      return {
        success: false,
        error: 'Associate a company with this deal in HubSpot before accepting: the invoice needs a customer.',
      }
    }

    // 2) Delivery address: the submitted one, falling back to what the
    //    registry already holds. Sanitized to TaxJar's format either way.
    const supabase = await createServerClient()
    const { data: regRow, error: regError } = await supabase
      .from('deals_registry')
      .select('delivery_street, delivery_city, delivery_state, delivery_zip, deal_probability')
      .eq('hubspot_deal_id', dealId)
      .maybeSingle()
    if (regError) {
      return { success: false, error: 'Could not load the saved delivery address. Please try again.' }
    }
    const address = sanitizeUSAddress(
      acceptance?.delivery ?? {
        street: regRow?.delivery_street ?? '',
        city: regRow?.delivery_city ?? '',
        state: regRow?.delivery_state ?? '',
        zip: regRow?.delivery_zip ?? '',
      },
    )
    if (!address.ok) {
      return { success: false, error: address.error }
    }

    // 3) Probability of close (the backbone): submitted or already stored.
    const effectiveProbability = parsedProbability ?? (regRow?.deal_probability === null || regRow?.deal_probability === undefined ? null : Number(regRow.deal_probability))
    if (effectiveProbability === null || !Number.isFinite(effectiveProbability)) {
      return { success: false, error: 'Set the deal probability before accepting.' }
    }

    // 4) Persist to the registry (session client, RLS-enforced). Never writes
    //    deal_status or depot_code: those keep flowing HubSpot -> n8n, so the
    //    Hub's own write can never fire the accepted-quote trigger or race
    //    the sync.
    //
    //    UPDATE, not upsert, and that distinction is the whole bug this
    //    replaced. deals_registry.deal_status is NOT NULL with NO DEFAULT, and
    //    Postgres validates an INSERT tuple BEFORE it resolves ON CONFLICT, so
    //    an upsert that omits deal_status fails with a not-null violation even
    //    when the row plainly exists. Every acceptance from the Hub failed on
    //    that, reporting "the deal is outside your pipeline" while the real
    //    cause had nothing to do with RLS.
    const registryPatch = {
      pipeline_id: pipelineId,
      delivery_street: address.value.street,
      delivery_city: address.value.city,
      delivery_state: address.value.state,
      delivery_zip: address.value.zip,
      delivery_country: 'US',
      ...(parsedProbability !== null ? { deal_probability: parsedProbability } : {}),
      updated_at: new Date().toISOString(),
    }

    const { data: updatedRows, error: writeError } = await supabase
      .from('deals_registry')
      .update(registryPatch)
      .eq('hubspot_deal_id', dealId)
      // Selected back because an RLS UPDATE policy FILTERS rows rather than
      // raising: a deal outside the caller's pipeline returns error null and
      // zero rows, and without this the rep would be told it saved.
      .select('hubspot_deal_id')

    if (writeError) {
      console.error('deals_registry acceptance update failed', writeError.message)
      return {
        success: false,
        error: 'Could not save the delivery address for this deal. Please try again.',
      }
    }

    if (!updatedRows || updatedRows.length === 0) {
      // No row to update. Either the deal has never been quoted through the Hub
      // and n8n has not synced it yet, or it sits outside the caller's pipeline
      // and RLS filtered it away. The insert distinguishes them: RLS refuses it
      // too, and only then is the pipeline message the right one.
      //
      // deal_status has to be supplied here because the column is NOT NULL with
      // no default. 'Quote Created' is the same neutral placeholder createQuote
      // uses, and deliberately NOT the accepted stage id, so this insert cannot
      // fire notify_quote_accepted. n8n's stage sync corrects it moments later.
      const { error: insertError } = await supabase
        .from('deals_registry')
        .insert({ hubspot_deal_id: dealId, deal_status: 'Quote Created', ...registryPatch })

      if (insertError) {
        console.error('deals_registry acceptance insert failed', insertError.message)
        return {
          success: false,
          error:
            'Could not save the delivery address for this deal. If the deal is outside your pipeline it cannot be accepted from the Hub.',
        }
      }
    }
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

    // Piggyback the probability onto the same PATCH (one write, no extra call).
    if (acceptance?.winProbability && parsedProbability !== null) {
      properties.win_probability = acceptance.winProbability
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
