'use server'

import { createServerClient } from '@/lib/supabase/server'
import { getDealDetails } from '@/app/actions/hubspot/getDealDetails'
import { updateDealStage, getDistributorStageForPipeline } from '@/app/actions/hubspot/updateDealStage'
import { addLineItemsToDeal } from '@/app/actions/hubspot/addLineItems'
import { getProductSkus } from '@/app/actions/hubspot/getProductSkus'
import { QUOTATION_SENT_STAGES, HUBSPOT_PIPELINES } from '@/lib/hubspot-constants'
import { parseWinProbability, validateLineItems } from '@/lib/quote-math'
import { priceCart, toRegistryLine } from '@/lib/quote-pricing'
import { runQuotePipeline, type PublishedQuote } from '@/app/actions/sales/publish-quote'
import { nextQuoteNumber } from '@/lib/hubspot-quote'
import { quoteTemplateIdFor } from '@/lib/pipeline-config'
import { splitFullName } from '@/lib/name'
import { createAdminClient } from '@/lib/supabase/admin'
import { loadPricingForQuote } from '@/app/actions/pricing/get-pricing'
import type { DiscountMode } from '@/lib/pricing'
import { assertDealAccess } from '@/lib/authz'
import { findOutOfScopeSkus } from '@/lib/quote-sku-scope'

interface QuoteLineItem {
  productId: string
  name: string
  quantity: number
  /** A PROPOSAL. Honoured only for a SKU with no Supabase price; otherwise the
   *  server resolves the price itself and this is ignored. */
  unitPrice: number
  total: number
  sku?: string
  description?: string
  /** The rep's discount entry, as a percentage or as money off each unit. Also
   *  a proposal: the cap is enforced server-side against the resolved base. */
  discountMode?: DiscountMode
  discountValue?: number
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
  /** Free-text rep comments, printed on the quote under "Comments from {rep}". */
  comments?: string
  /**
   * Will Call: the customer collects from the sending depot.
   *
   * ALWAYS written to deals_registry.is_collection, unlike depot and
   * probability which are only written when supplied. Those are guarded
   * because n8n syncs them from HubSpot and a blank re-quote must not null a
   * synced value. HubSpot has no collect-versus-deliver property at all, so
   * the Hub is this column's only writer and the checkbox IS the answer,
   * including when the rep unticks it.
   */
  isCollection?: boolean
  isPreview?: boolean
  pdfBlob?: Blob // We can't pass Blob to server action directly, need FormData or base64
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
    .select('display_name, phone, is_super_admin, pipeline_id, allowed_depots, allowed_distributors, allowed_quote_templates')
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

  // An empty cart used to skip addLineItemsToDeal entirely, so the deal stage
  // and a zero amount were written while the PREVIOUS HubSpot line items
  // survived untouched. The replace guarantee only holds for a non-empty cart.
  // Refused here, before any write, so nothing is half-applied.
  if (params.lineItems.length === 0) {
    return { success: false, error: 'Add at least one line item before generating a quote.' }
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
  // Derived for EVERY caller, not just the ones the depot guard runs for,
  // because pricing needs it too. A line's SKU decides which list or contract
  // price applies, and taking that from the browser let a crafted request send
  // a real productId with a blank sku, fall through to the "no Supabase price"
  // branch, and name its own unit price. Fetched once and used by both.
  const productIds = Array.from(
    new Set(
      params.lineItems
        .map((li) => li.productId?.trim())
        .filter((id): id is string => !!id)
    )
  )
  const skuResult = productIds.length > 0
    ? await getProductSkus(productIds)
    : { success: true as const, data: {} as Record<string, string> }
  if (!skuResult.success) {
    console.error('getProductSkus failed:', skuResult.error)
    return { success: false, error: 'Could not verify products with HubSpot. Please try again.' }
  }
  /** productId to the SKU HubSpot holds. The authority on what each line IS. */
  const skuByProductId: Record<string, string> = skuResult.data ?? {}

  if (!profile.is_super_admin && isDirectSale) {
    // With no depot chosen yet, validate against the union of the caller's own
    // depots — cross-region SKUs (EB-SRO's manufacturing codes above all) stay
    // blocked even before the fulfilment depot is decided.
    const depotScope: string[] = effectiveDepot
      ? [effectiveDepot]
      : ((profile.allowed_depots as string[] | null) ?? [])

    const derivedSkus = Object.values(skuByProductId)
    const clientSkus = params.lineItems
      .map((li) => li.sku?.trim())
      .filter((s): s is string => !!s)
    const quotedSkus = Array.from(new Set([...derivedSkus, ...clientSkus]))

    if (quotedSkus.length > 0) {
      // Shared with the edit path: republishing an edited quote can add a line
      // this quote never had, so the same check has to run there too.
      const scope = await findOutOfScopeSkus(supabase, quotedSkus, depotScope)
      if (!scope.ok) return { success: false, error: scope.error }

      if (scope.wrongDepot.length > 0) {
        return {
          success: false,
          error: effectiveDepot
            ? `These products are not available from ${effectiveDepot}: ${scope.wrongDepot.join(', ')}`
            : `These products are not available from your depots: ${scope.wrongDepot.join(', ')}`,
        }
      }
    }
  }

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
  const parsedProbability = parseWinProbability(params.winProbability)

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

  /** HubSpot ids of the line items created below, in the order they were sent. */
  // 3b. Price the cart server-side. The client's unit prices and percentages
  // are proposals: the price comes from Supabase (contract, then list) and the
  // cap is checked against the resolved base, so a crafted request can neither
  // name its own price nor discount past what Dave allowed. The only figure
  // still taken from the browser is the unit price of a SKU with no Supabase
  // row at all, which is exactly today's behaviour and stays legal while the
  // price list is being filled.
  //
  // Reads the SAME rows the builder was given, through the same loader, so the
  // two cannot disagree about what the list price was.
  const dealCurrencyForPricing = String(deal?.properties?.deal_currency_code ?? 'USD').trim().toUpperCase() || 'USD'
  const pricing = await loadPricingForQuote({
    companyId,
    currency: dealCurrencyForPricing,
    userId: user.id,
  })
  const pricedCart = priceCart({
    // The SKU comes from HubSpot, never from the browser. Falling back to the
    // client value only when HubSpot has none keeps a genuinely SKU-less
    // product quotable, which is the case the manual price path exists for.
    lines: params.lineItems.map((li) => ({
      ...li,
      sku: skuByProductId[String(li.productId ?? '').trim()] ?? li.sku,
    })),
    currency: dealCurrencyForPricing,
    companyId,
    listPrices: pricing.listPrices,
    contractPrices: pricing.contractPrices,
    cap: pricing.cap,
    isSuperAdmin: profile.is_super_admin === true,
    today: new Date().toISOString().slice(0, 10),
  })
  if (!pricedCart.ok) {
    // Before any HubSpot write, so a refused discount leaves nothing behind.
    return { success: false, error: pricedCart.error }
  }
  const computedTotal = pricedCart.total

  // 3c. The HubSpot quote template, checked HERE rather than at publish time.
  //
  // A quote cannot be published without one and the association cannot be added
  // after creation, so a missing template is fatal. It used to be discovered at
  // the very end, after the deal had been moved to Quotation sent, its line
  // items replaced and the registry row written, and after a refusal that
  // happened before the deal_quotes row existed, which left Retry with nothing
  // to resume. The rep was stuck with a half-applied deal and no way forward.
  //
  // Six of eight live profiles carry no allowed_quote_templates at all and fall
  // through to the value 'default', which has no template id, so this is the
  // common case rather than an edge one.
  const quoteTemplateId = quoteTemplateIdFor(params.template)
  if (!quoteTemplateId) {
    return {
      success: false,
      error: `No HubSpot quote template is mapped to "${params.template || 'none'}", so a quote cannot be branded or published. Choose the US or Canada template in Quote Setup, or ask for this one to be mapped. Nothing has been changed.`,
    }
  }

  let createdLineItemIds: string[] = []

  // Without a pipeline there is no stage to move the deal to, so every HubSpot
  // write below is skipped. This used to fall through to the registry upsert and
  // return success, so the rep saw "quote generated" while HubSpot had nothing:
  // no stage change, no line items, no PDF on the deal. Fail loudly instead.
  if (!pipelineId) {
    console.error('createQuote: no pipeline on deal', params.dealId)
    return {
      success: false,
      error:
        'Could not read this deal from HubSpot, so nothing was written. Reopen the deal and try again.',
    }
  }

  // A rep may READ any deal they own (see isDealInScope), but the
  // deals_registry INSERT policy requires the row's pipeline_id to equal their
  // OWN profile pipeline. Quoting a deal from another pipeline would write the
  // stage change, line items and PDF to HubSpot and only then be refused by
  // RLS, leaving the change half applied. Refuse before any write instead.
  // This is the case for inbound web-form requests, which land in the Demo
  // pipeline rather than the rep's.
  if (!profile.is_super_admin && pipelineId !== profile.pipeline_id) {
    console.error('createQuote: deal outside caller pipeline', params.dealId, pipelineId)
    return {
      success: false,
      error:
        'This request sits in a different HubSpot pipeline to yours, so a quote cannot be raised against it yet. Move the deal into your own pipeline in HubSpot first, then reopen it here.',
    }
  }

  // 4. Update Deal Stage and Add Line Items
  {
    // A. Handle Distributor Logic
    if (params.distributor !== 'Direct Sale') {
      const distributorStageId = await getDistributorStageForPipeline(pipelineId)
      // Only USA_SALES and EURO_SALES have a distributor stage mapped. Any other
      // pipeline used to fall through silently: no stage move, but line items and
      // the PDF still written and success returned.
      if (!distributorStageId) {
        console.error('createQuote: no distributor stage for pipeline', pipelineId)
        return {
          success: false,
          error: 'This pipeline has no distributor stage configured, so the deal was not moved. Nothing was changed.',
        }
      }
      const r = await updateDealStage(params.dealId, pipelineId, distributorStageId, effectiveDepot ?? undefined, computedTotal)
      if (!r.success) return { success: false, error: r.error || 'Failed to update deal stage' }
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

      if (!quotationSentStageId) {
        console.error('createQuote: no Quotation Sent stage for pipeline', pipelineId)
        return {
          success: false,
          error: 'This pipeline has no Quotation Sent stage configured, so the deal was not moved. Nothing was changed.',
        }
      }
      const r = await updateDealStage(params.dealId, pipelineId, quotationSentStageId, effectiveDepot ?? undefined, computedTotal)
      if (!r.success) return { success: false, error: r.error || 'Failed to update deal stage' }
    }

    // C. Add Line Items to HubSpot Deal. The cart is guaranteed non-empty by
    // the pre-write guard above.
    {
      const r = await addLineItemsToDeal(
        params.dealId,
        pricedCart.lines.map((l) => ({
          productId: l.productId,
          name: l.name,
          quantity: l.quantity,
          // The base, with the discount as its own property: HubSpot derives
          // the line amount itself and would discount the net a second time.
          unitPrice: l.priced.hubspot.price,
          total: l.lineTotal,
          sku: l.sku,
          description: l.description,
          discountPercentage: l.priced.hubspot.hs_discount_percentage,
          discountPerUnit: l.priced.hubspot.discount,
        })),
        dealCurrencyForPricing,
      )
      if (r.success) createdLineItemIds = r.lineItemIds ?? []
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
    quote_reference: quoteReference, // Will preserve existing ref if upserting
    // A distributor quote has no depot, so it can have no collection. `=== true`
    // because this action has no zod schema and the value crosses the wire.
    is_collection: isDirectSale && params.isCollection === true,
    // Written in the SAME key shape the rest of the system uses, not the
    // builder's camelCase. notify_quote_accepted() reads unit_price,
    // total_amount and hs_product_id straight off these elements and COALESCEs
    // a miss to 0 — so a camelCase row reaching Quotation Accepted would post a
    // draft Xero quote and an MCS contract with every price and line total at
    // zero. n8n's own sync writes snake_case, which is why the mismatch has
    // never shown up: no Hub quote has reached acceptance yet.
    // Written in the SAME key shape the rest of the system uses, not the
    // builder's camelCase. notify_quote_accepted() reads unit_price,
    // total_amount and hs_product_id straight off these elements and COALESCEs
    // a miss to 0, so a camelCase row reaching Quotation Accepted would post a
    // draft Xero quote and an MCS contract with every price and line total at
    // zero.
    //
    // unit_price is the PRE-discount base and discount_percentage carries the
    // cut, which is the pair buildDraftLines bills with. A cash discount stores
    // the net with a zero percentage instead, so the invoice charges an exact
    // figure rather than re-deriving one. The BEFORE trigger on this table
    // merges its Xero fields into each element rather than rebuilding it, so
    // the new audit keys survive.
    line_items_raw: pricedCart.lines.map((line, i) => toRegistryLine(line, createdLineItemIds[i])),
    updated_at: new Date().toISOString(),
  }
  // The deal's OWN currency, read off the getDealDetails call already made
  // above rather than taken from the client, so there is no new trust surface.
  //
  // The literal 'USD' this replaces was actively corrupting rows: the n8n sync
  // writes the real currency, and a re-quote through the Hub overwrote it. Six
  // CA-HAM rows sit at USD against 23 at CAD for exactly this reason.
  //
  // When the deal carries no currency the key is OMITTED, never defaulted: on
  // insert the column default applies, and on update the synced value survives.
  const dealCurrency = String(deal?.properties?.deal_currency_code ?? '').trim().toUpperCase()
  if (dealCurrency) registryRow.currency = dealCurrency
  if (pipelineId) registryRow.pipeline_id = pipelineId
  if (parsedProbability !== null) registryRow.deal_probability = parsedProbability
  // Depot follows the same don't-null-a-synced-value rule as probability: an
  // undecided re-quote must NOT wipe a depot already on the row — the Xero/MCS
  // trigger (notify_quote_accepted) silently disarms without a valid depot_code,
  // and the authoritative depot choice happens at the acceptance transition.
  if (effectiveDepot !== null) registryRow.depot_code = effectiveDepot
  // Same don't-null-a-synced-value rule: an empty comments box on a re-quote
  // must not wipe out comments that were written (and printed) previously.
  const trimmedComments = params.comments?.trim()
  if (trimmedComments) registryRow.quote_comments = trimmedComments

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

  // 6. LAST: the HubSpot quote itself.
  //
  // Deliberately after everything else. The deal stage, its line items and the
  // registry row are the parts other systems depend on, and a quote that fails
  // to publish must not leave any of them half applied. A failure here returns
  // success with a quoteError instead, so the rep is offered Retry quote rather
  // than a second Generate that would redo all the writes above.
  const admin = createAdminClient()
  const { count: existingQuoteCount } = await admin
    .from('deal_quotes')
    .select('id', { count: 'exact', head: true })
    .eq('hubspot_deal_id', params.dealId)
    .eq('status', 'published')

  const contactId = deal?.associations?.contacts?.results?.[0]?.id ?? null
  const senderName = splitFullName(profile.display_name || '')
  const quoteResult = await runQuotePipeline({
    dealId: params.dealId,
    title: dealName,
    currency: dealCurrencyForPricing,
    templateKey: params.template,
    contactId,
    companyId: companyId === 'UNKNOWN' ? null : companyId,
    comments: trimmedComments,
    // One number across the quote, the deal and the Xero invoice. A regenerate
    // makes a NEW quote object rather than editing the published one, so the
    // second carries a suffix: two live quotes with the same number is what the
    // rep would otherwise send.
    quoteNumber: nextQuoteNumber(quoteReference, existingQuoteCount ?? 0),
    sender: {
      firstname: senderName.firstname,
      lastname: senderName.lastname,
      email: user.email,
      phone: profile.phone,
    },
    lines: pricedCart.lines,
    hubAmount: computedTotal,
    createdByUid: user.id,
    createdByLabel: user.email ?? 'Hub user',
  })

  if (!quoteResult.success) {
    return { success: true, quoteReference, quoteError: quoteResult.error }
  }

  return { success: true, quoteReference, quote: quoteResult.quote satisfies PublishedQuote }
}
