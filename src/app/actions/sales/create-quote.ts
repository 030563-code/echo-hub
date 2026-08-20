'use server'

import { createServerClient } from '@/lib/supabase/server'
import { getDealDetails } from '@/app/actions/hubspot/getDealDetails'
import { updateDealStage, getDistributorStageForPipeline } from '@/app/actions/hubspot/updateDealStage'
import { addLineItemsToDeal } from '@/app/actions/hubspot/addLineItems'
import { getProductSkus } from '@/app/actions/hubspot/getProductSkus'
import { uploadFileToHubSpot, createNoteWithAttachment, createEmailDraftWithAttachment } from '@/app/actions/hubspot/uploadFile'
import { QUOTATION_SENT_STAGES, HUBSPOT_PIPELINES } from '@/lib/hubspot-constants'
import { computeLineItemsTotal, validateLineItems, findSuspiciousLines } from '@/lib/quote-math'
import { assertDealAccess } from '@/lib/authz'

interface QuoteLineItem {
  productId: string
  name: string
  quantity: number
  unitPrice: number
  total: number
  sku?: string
}

interface CreateQuoteParams {
  dealId: string
  distributor: string
  /** Optional at quote time — the depot is a fulfilment decision, only
   *  REQUIRED when the deal is moved to Quotation Accepted (updateDealStage
   *  enforces that transition). */
  depot?: string
  template: string
  lineItems: QuoteLineItem[]
  totalAmount: number
  /**
   * Probability of close — the backbone field. The HubSpot win_probability option
   * value selected in the quote setup. Persisted to deals_registry.deal_probability
   * so the MRP/forecasting engine can weight pipeline demand by it.
   */
  winProbability?: string
  /** Set after the rep explicitly confirms quoting below typical prices. */
  confirmLowPrices?: boolean
  isPreview?: boolean
  pdfBlob?: Blob // We can't pass Blob to server action directly, need FormData or base64
}

// Helper to handle file upload separately
export async function handleQuoteFileUpload(formData: FormData) {
  const dealId = formData.get('dealId') as string
  if (!dealId) return { success: false, error: 'Missing dealId' }

  // IDOR guard: verify deal access (quotes.create capability + pipeline) BEFORE
  // uploading the file, so an out-of-pipeline dealId can't litter a PDF into the
  // shared portal.
  const access = await assertDealAccess(dealId, 'quotes.create')
  if (!access.ok) return { success: false, error: access.error }

  const uploadResult = await uploadFileToHubSpot(formData)
  if (!uploadResult.success || !uploadResult.fileId) {
    return { success: false, error: uploadResult.error }
  }

  // Attach to Deal via Note
  const noteResult = await createNoteWithAttachment(dealId, uploadResult.fileId)
  if (!noteResult.success) {
    return { success: false, error: noteResult.error || 'Failed to attach quote to deal' }
  }

  // Create Email Engagement (Removed as per request)
  // await createEmailDraftWithAttachment(dealId, uploadResult.fileId)

  return { success: true, fileId: uploadResult.fileId }
}

export async function createQuote(params: CreateQuoteParams) {
  // If it's a preview, we DO NOT update HubSpot or Supabase
  if (params.isPreview) {
    return { success: true, quoteReference: 'PREVIEW' }
  }

  // IDOR guard: verify deal access (quotes.create capability + pipeline) at the
  // TOP, before any Supabase side-effect (quote-ref sequence, deals_registry
  // upsert). Otherwise an agent could pass another team's dealId + their own depot
  // and overwrite that deal's registry row / burn quote numbers.
  const access = await assertDealAccess(params.dealId, 'quotes.create')
  if (!access.ok) {
    return { success: false, error: access.error }
  }

  const supabase = await createServerClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    return { success: false, error: 'User not authenticated' }
  }

  // 1. Get user profile + access restrictions
  const { data: profile } = await supabase
    .from('profiles')
    .select('display_name, is_super_admin, allowed_depots, allowed_distributors, allowed_quote_templates')
    .eq('id', user.id)
    .maybeSingle()

  if (!profile) {
    return { success: false, error: 'User profile not found' }
  }

  // Distributor (pass-to-distributor) quotes have NO depot — the form hides the
  // depot selector. Only direct sales carry a depot to validate/store.
  const isDirectSale = !params.distributor || params.distributor === 'Direct Sale'
  const requestedDepot = params.depot?.trim() || null

  // 1a. Validate the requested depot/distributor/template against the caller's
  // own allowances (finding #10). Super admins bypass.
  //
  // NB: deals_registry RLS enforces CAPABILITY + REGION (pipeline_id) at the DB
  // layer — it does NOT reference depot_code. A previous comment here claimed
  // depot was enforced in the database; it never was. THIS check is the only
  // thing standing between a caller and another depot's quote.
  if (!profile.is_super_admin) {
    const allowedDepots: string[] = profile.allowed_depots ?? []
    const allowedDistributors: string[] = profile.allowed_distributors ?? []
    const allowedTemplates: string[] = profile.allowed_quote_templates ?? []

    if (isDirectSale) {
      // Depot is optional at quote time (chosen at Quotation Accepted) — but
      // when one IS chosen it must be the caller's own, and a profile with no
      // depots at all has nothing to defer TO: without this check they'd sail
      // through setup and quote unmapped SKUs (the guard below fails open for
      // those by design).
      if (requestedDepot && !allowedDepots.includes(requestedDepot)) {
        return { success: false, error: 'You are not permitted to quote for this depot' }
      }
      if (!requestedDepot && allowedDepots.length === 0) {
        return { success: false, error: 'No sending depots are assigned to your profile — ask an administrator before quoting direct sales.' }
      }
    } else if (!allowedDistributors.includes(params.distributor)) {
      return { success: false, error: 'You are not permitted to quote for this distributor' }
    }
    if (params.template && allowedTemplates.length > 0 && !allowedTemplates.includes(params.template)) {
      return { success: false, error: 'You are not permitted to use this quote template' }
    }
  }

  // 1a-i. Structural validation of the line items themselves — quantity/price
  // shape — BEFORE any HubSpot write. Runs for every caller, not just non-admins;
  // a super admin sending garbage quantities should be rejected too.
  const lineItemsError = validateLineItems(params.lineItems)
  if (lineItemsError) {
    return { success: false, error: lineItemsError }
  }

  // The depot is only meaningful for direct sales; distributor quotes store
  // null, and a direct sale may also be null until acceptance.
  const effectiveDepot = isDirectSale ? requestedDepot : null

  // 1a-ii. Line items must belong to the depot being quoted. The form narrows the
  // product picker by depot, but that is a CONVENIENCE, not a control — nothing
  // stopped a crafted request carrying another location's SKUs through to live
  // HubSpot (notably the 22 EB-SRO manufacturing codes, which must never appear on
  // a customer quote). Mirrors the catalogue check in create-po.ts.
  //
  // SKUs are derived server-side from HubSpot (by productId), not trusted from
  // client-supplied li.sku — a crafted request could omit/blank sku while still
  // supplying a restricted productId, bypassing this check entirely. We validate
  // the UNION of the derived SKUs and any client-supplied ones, so neither can be
  // used to hide a product from the check.
  //
  // Deliberately FAILS OPEN for unmapped SKUs: product_depot_mapping is known
  // incomplete (01-EBH9, H8, Transport and NO_SKU_FOUND all appear on real quotes
  // but are in no depot), so rejecting the unmapped would block legitimate work.
  // A SKU is refused only when it IS mapped elsewhere but NOT to this depot —
  // which is exactly the cross-location case this guard exists to stop. The one
  // exception is the SKU derivation itself: if we can't reach HubSpot to derive
  // SKUs, we FAIL CLOSED (below) rather than silently trusting the client.
  if (!profile.is_super_admin && isDirectSale) {
    // With no depot chosen yet, validate against the union of the caller's own
    // depots — cross-region SKUs (EB-SRO's manufacturing codes above all) stay
    // blocked even before the fulfilment depot is decided.
    const depotScope: string[] = effectiveDepot
      ? [effectiveDepot]
      : ((profile.allowed_depots as string[] | null) ?? [])
    const productIds = Array.from(
      new Set(
        params.lineItems
          .map((li) => li.productId?.trim())
          .filter((id): id is string => !!id)
      )
    )

    const skuResult = await getProductSkus(productIds)
    if (!skuResult.success) {
      console.error('getProductSkus failed:', skuResult.error)
      return { success: false, error: 'Could not verify products for this depot. Please try again.' }
    }

    const derivedSkus = Object.values(skuResult.data ?? {})
    const clientSkus = params.lineItems
      .map((li) => li.sku?.trim())
      .filter((s): s is string => !!s)
    const quotedSkus = Array.from(new Set([...derivedSkus, ...clientSkus]))

    if (quotedSkus.length > 0) {
      const { data: mapRows, error: mapError } = await supabase
        .from('product_depot_mapping')
        .select('hubspot_sku_code, depot_code')
        .eq('is_active', true)
        .in('hubspot_sku_code', quotedSkus)

      if (mapError) {
        console.error('product_depot_mapping lookup failed:', mapError.message)
        return { success: false, error: 'Could not verify products for this depot. Please try again.' }
      }

      const mappedAnywhere = new Set((mapRows ?? []).map((r) => r.hubspot_sku_code))
      const allowedHere = new Set(
        (mapRows ?? []).filter((r) => depotScope.includes(r.depot_code)).map((r) => r.hubspot_sku_code)
      )
      const wrongDepot = quotedSkus.filter((s) => mappedAnywhere.has(s) && !allowedHere.has(s))

      if (wrongDepot.length > 0) {
        return {
          success: false,
          error: effectiveDepot
            ? `These products are not available from ${effectiveDepot}: ${wrongDepot.join(', ')}`
            : `These products are not available from your depots: ${wrongDepot.join(', ')}`,
        }
      }
    }
  }

  // 1a-iii. Low-price sanity gate. The HubSpot product library carries $1
  // placeholder prices on the NA products, and $1 H9 lines have already gone
  // out on real quotes ($185 typical). Lines far below the SKU's typical price
  // (from the caller's own region-scoped quote history) are refused until the
  // rep explicitly confirms. Keyed on client-supplied SKUs: this is an
  // error-margin guard for the UI flow, not a security boundary — the
  // depot/SKU guard above is the control.
  if (!params.confirmLowPrices) {
    const priceCheckSkus = Array.from(
      new Set(params.lineItems.map((li) => li.sku?.trim()).filter((v): v is string => !!v))
    )
    if (priceCheckSkus.length > 0) {
      const { data: statRows, error: statError } = await supabase.rpc('get_sku_price_stats', {
        p_skus: priceCheckSkus,
      })
      // Stats are advisory — if the lookup fails, don't block quoting.
      if (statError) {
        console.error('get_sku_price_stats failed:', statError.message)
      } else {
        const stats: Record<string, { medianPrice: number }> = {}
        for (const row of (statRows ?? []) as { sku: string; median_price: number }[]) {
          stats[row.sku] = { medianPrice: Number(row.median_price) }
        }
        // Mapped product SKUs with NO history still get the placeholder floor
        // (<= $5) — the rarely-quoted NA products are exactly where HubSpot's
        // $1 placeholder survives.
        const { data: mappedRows } = await supabase
          .from('product_depot_mapping')
          .select('hubspot_sku_code')
          .eq('is_active', true)
          .in('hubspot_sku_code', priceCheckSkus)
        const suspicious = findSuspiciousLines(
          params.lineItems.map((li) => ({ sku: li.sku, unitPrice: li.unitPrice })),
          stats,
          { mappedSkus: (mappedRows ?? []).map((r) => r.hubspot_sku_code) }
        )
        if (suspicious.length > 0) {
          const detail = suspicious
            .map((l) =>
              l.typicalPrice != null
                ? `${l.sku} at $${l.unitPrice} (recent quotes run ~$${l.typicalPrice})`
                : `${l.sku} at $${l.unitPrice} (no price history — this looks like HubSpot's placeholder price)`
            )
            .join('; ')
          return {
            success: false,
            code: 'LOW_PRICE_CONFIRM' as const,
            lowPriceLines: suspicious,
            error: `Price check: ${detail}. Confirm the low price to continue.`,
          }
        }
      }
    }
  }

  // 1b. Recompute the amount server-side from the line items — never trust the
  // client-supplied totalAmount (finding #10).
  const computedTotal = computeLineItemsTotal(params.lineItems)

  // 1c. Probability of close (the backbone). Parse the HubSpot win_probability
  // option value to a number for deals_registry.deal_probability; null if absent
  // or non-numeric (don't clobber an n8n-synced value with null on re-quote).
  // HubSpot's win_probability option VALUES are percent strings ('10%' … '100%'),
  // so Number('70%') is NaN and the field was silently dropped on EVERY quote —
  // deal_probability was null on all 2,031 deals_registry rows. Strip the percent
  // sign (and stray whitespace) before parsing, and accept only 0-100.
  // Wrapped in String(...) — winProbability is typed as string, but a numeric
  // value at runtime (e.g. from a caller that skips the client form) has no
  // .trim() and would throw TypeError before ever reaching Number.isFinite below.
  const probabilityRaw = String(params.winProbability ?? '').trim().replace(/%$/, '').trim()
  const probabilityNum = probabilityRaw === '' ? Number.NaN : Number(probabilityRaw)
  const parsedProbability =
    Number.isFinite(probabilityNum) && probabilityNum >= 0 && probabilityNum <= 100
      ? probabilityNum
      : null

  const displayName = profile.display_name || user.email || 'XX'
  const initials = displayName
    .split(' ')
    .map((n: string) => n[0])
    .join('')
    .toUpperCase()
    .substring(0, 2)

  // 2. Check if Deal already exists in registry
  const { data: existingDeal } = await supabase
    .from('deals_registry')
    .select('quote_reference')
    .eq('hubspot_deal_id', params.dealId)
    .maybeSingle()

  let quoteReference = existingDeal?.quote_reference

  // 3. Fetch Deal Details for Company ID
  const { data: deal } = await getDealDetails(params.dealId)
  const companyId = deal?.associations?.companies?.results?.[0]?.id || 'UNKNOWN'
  const dealName = deal?.properties?.dealname || 'Unknown Deal'
  const pipelineId = deal?.properties?.pipeline

  // 4. Update Deal Stage and Add Line Items
  if (pipelineId) {
    // A. Handle Distributor Logic
    if (params.distributor !== 'Direct Sale') {
      const distributorStageId = await getDistributorStageForPipeline(pipelineId)
      if (distributorStageId) {
        const r = await updateDealStage(params.dealId, pipelineId, distributorStageId, effectiveDepot ?? undefined, computedTotal)
        if (!r.success) return { success: false, error: r.error || 'Failed to update deal stage' }
      }
    } else {
      // B. Handle Direct Sale Logic (Move to Quotation Sent)
      // Find the "Quotation Sent" stage for this pipeline
      let quotationSentStageId = null
      
      // Iterate through pipelines to find matching one and get its Quotation Sent stage
      for (const key in HUBSPOT_PIPELINES) {
        const pipeline = HUBSPOT_PIPELINES[key as keyof typeof HUBSPOT_PIPELINES]
        if (pipeline.id === pipelineId) {
          // Try to find a stage key that looks like QUOTATION_SENT
          const stageKey = Object.keys(pipeline.stages).find(k => k.includes('QUOTATION_SENT') || k.includes('QUOTATION_RECEIVED'))
          if (stageKey) {
            quotationSentStageId = pipeline.stages[stageKey as keyof typeof pipeline.stages]
            break
          }
        }
      }

      if (quotationSentStageId) {
        const r = await updateDealStage(params.dealId, pipelineId, quotationSentStageId, effectiveDepot ?? undefined, computedTotal)
        if (!r.success) return { success: false, error: r.error || 'Failed to update deal stage' }
      }
    }

    // C. Add Line Items to HubSpot Deal
    if (params.lineItems.length > 0) {
      const r = await addLineItemsToDeal(params.dealId, params.lineItems)
      // addLineItemsToDeal now replaces rather than appends, so retrying here is
      // safe — the specific HubSpot error (if any) is already logged inside it;
      // the user-facing message leads with the safe-to-retry fact instead.
      if (!r.success) {
        return {
          success: false,
          error:
            'The deal stage was updated but adding line items failed — it is safe to click Generate again; line items are replaced, not duplicated.',
        }
      }
    }
  }

  // 4d. Only NOW mint the quote reference. Every early return above (deal-stage
  // failure, line-item failure) used to happen AFTER this ran, permanently
  // burning a number from the sequence on a quote that was never created —
  // leaving gaps in the customer-visible quote numbering. The sequence is still
  // atomic; it is just claimed once the HubSpot side is known to have worked.
  if (!quoteReference) {
    const { data: seqData, error: seqError } = await supabase.rpc('get_next_quote_id')

    if (seqError || seqData == null) {
      console.error('get_next_quote_id failed:', seqError?.message)
      return { success: false, error: 'Could not generate a quote reference. Please try again.' }
    }

    const year = new Date().getFullYear()
    const paddedSequence = Number(seqData).toString().padStart(5, '0')
    quoteReference = `${initials}${year}${paddedSequence}`
  }

  // 5. Upsert into deals_registry (insert or update on the unique hubspot_deal_id).
  // pipeline_id is written so Hub-created quotes are visible under the region-scoped
  // RLS; deal_probability is written only when supplied (don't null out a synced value).
  const registryRow: Record<string, unknown> = {
    hubspot_deal_id: params.dealId,
    hubspot_company_id: companyId,
    deal_name: dealName,
    deal_status: 'Quote Created',
    amount: computedTotal,
    currency: 'USD',
    quote_reference: quoteReference, // Will preserve existing ref if upserting
    line_items_raw: params.lineItems,
    updated_at: new Date().toISOString(),
  }
  if (pipelineId) registryRow.pipeline_id = pipelineId
  if (parsedProbability !== null) registryRow.deal_probability = parsedProbability
  // Depot follows the same don't-null-a-synced-value rule as probability: an
  // undecided re-quote must NOT wipe a depot already on the row — the Xero/MCS
  // trigger (notify_quote_accepted) silently disarms without a valid depot_code,
  // and the authoritative depot choice happens at the acceptance transition.
  if (effectiveDepot !== null) registryRow.depot_code = effectiveDepot

  const { error: upsertError } = await supabase
    .from('deals_registry')
    .upsert(registryRow, { onConflict: 'hubspot_deal_id' })

  if (upsertError) {
    console.error('Supabase upsert error:', upsertError)
    // HubSpot already has the deal stage + line items at this point, and
    // addLineItemsToDeal replaces rather than appends — so retrying is safe.
    return {
      success: false,
      error: 'The quote was created in HubSpot but could not be saved to the Hub database — it is safe to click Generate again.',
    }
  }

  return { success: true, quoteReference }
}
