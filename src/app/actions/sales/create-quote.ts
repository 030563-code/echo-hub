'use server'

import { createServerClient } from '@/lib/supabase/server'
import { getDealDetails } from '@/app/actions/hubspot/getDealDetails'
import { updateDealStage, getDistributorStageForPipeline } from '@/app/actions/hubspot/updateDealStage'
import { addLineItemsToDeal } from '@/app/actions/hubspot/addLineItems'
import { uploadFileToHubSpot, createNoteWithAttachment, createEmailDraftWithAttachment } from '@/app/actions/hubspot/uploadFile'
import { QUOTATION_SENT_STAGES, HUBSPOT_PIPELINES } from '@/lib/hubspot-constants'
import { computeLineItemsTotal } from '@/lib/quote-math'
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
  depot: string
  template: string
  lineItems: QuoteLineItem[]
  totalAmount: number
  /**
   * Probability of close — the backbone field. The HubSpot win_probability option
   * value selected in the quote setup. Persisted to deals_registry.deal_probability
   * so the MRP/forecasting engine can weight pipeline demand by it.
   */
  winProbability?: string
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

  // 1a. Validate the requested depot/distributor/template against the caller's
  // own allowances (finding #10). Super admins bypass. deals_registry RLS also
  // enforces the depot check at the DB layer (defence in depth).
  if (!profile.is_super_admin) {
    const allowedDepots: string[] = profile.allowed_depots ?? []
    const allowedDistributors: string[] = profile.allowed_distributors ?? []
    const allowedTemplates: string[] = profile.allowed_quote_templates ?? []

    if (isDirectSale) {
      if (!params.depot || !allowedDepots.includes(params.depot)) {
        return { success: false, error: 'You are not permitted to quote for this depot' }
      }
    } else if (!allowedDistributors.includes(params.distributor)) {
      return { success: false, error: 'You are not permitted to quote for this distributor' }
    }
    if (params.template && allowedTemplates.length > 0 && !allowedTemplates.includes(params.template)) {
      return { success: false, error: 'You are not permitted to use this quote template' }
    }
  }

  // The depot is only meaningful for direct sales; distributor quotes store null.
  const effectiveDepot = isDirectSale ? params.depot : null

  // 1b. Recompute the amount server-side from the line items — never trust the
  // client-supplied totalAmount (finding #10).
  const computedTotal = computeLineItemsTotal(params.lineItems)

  // 1c. Probability of close (the backbone). Parse the HubSpot win_probability
  // option value to a number for deals_registry.deal_probability; null if absent
  // or non-numeric (don't clobber an n8n-synced value with null on re-quote).
  const parsedProbability =
    params.winProbability != null &&
    params.winProbability !== '' &&
    Number.isFinite(Number(params.winProbability))
      ? Number(params.winProbability)
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

  if (!quoteReference) {
    // Generate a NEW reference from the atomic DB sequence. The previous COUNT(*)
    // fallback produced colliding, non-unique references under concurrency
    // (finding #11) — fail loudly instead of risking a duplicate quote number.
    const { data: seqData, error: seqError } = await supabase.rpc('get_next_quote_id')

    if (seqError || seqData == null) {
      console.error('get_next_quote_id failed:', seqError?.message)
      return { success: false, error: 'Could not generate a quote reference. Please try again.' }
    }

    const year = new Date().getFullYear()
    const paddedSequence = Number(seqData).toString().padStart(5, '0')
    quoteReference = `${initials}${year}${paddedSequence}`
  }

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
      if (!r.success) return { success: false, error: r.error || 'Failed to add line items to deal' }
    }
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
    depot_code: effectiveDepot,
    line_items_raw: params.lineItems,
    updated_at: new Date().toISOString(),
  }
  if (pipelineId) registryRow.pipeline_id = pipelineId
  if (parsedProbability !== null) registryRow.deal_probability = parsedProbability

  const { error: upsertError } = await supabase
    .from('deals_registry')
    .upsert(registryRow, { onConflict: 'hubspot_deal_id' })

  if (upsertError) {
    console.error('Supabase upsert error:', upsertError)
    return { success: false, error: 'Failed to save quote. Please try again.' }
  }

  return { success: true, quoteReference }
}
