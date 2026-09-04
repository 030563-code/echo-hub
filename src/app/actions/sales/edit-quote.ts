'use server'

import { createServerClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { assertDealAccess } from '@/lib/authz'
import { hubspotFetch } from '@/lib/hubspot-client'
import { getDealDetails } from '@/app/actions/hubspot/getDealDetails'
import { addLineItemsToDeal } from '@/app/actions/hubspot/addLineItems'
import { updateDealAmount } from '@/app/actions/hubspot/updateDealAmount'
import { getProductSkus } from '@/app/actions/hubspot/getProductSkus'
import { loadPricingForQuote } from '@/app/actions/pricing/get-pricing'
import { priceCart, toRegistryLine, type PricedCartLine } from '@/lib/quote-pricing'
import { QUOTE_DRAFT_STATUS, buildQuoteLineItemInputs, commentsToHtml, quoteExpiryDate } from '@/lib/hubspot-quote'
import { validateLineItems } from '@/lib/quote-math'
import { findOutOfScopeSkus } from '@/lib/quote-sku-scope'
import {
  ACCEPTED_MID_EDIT_MESSAGE,
  isDealAccepted,
  recallBlockReason,
  republishBlockReason,
} from '@/lib/quote-edit'
import type { DiscountMode } from '@/lib/pricing'
import {
  HS,
  failQuoteStep,
  publishAndReadBack,
  readError,
  type PublishQuoteContext,
  type PublishedQuote,
  type QuoteStep,
} from '@/lib/quote-publish-tail'

/**
 * Recalling a published HubSpot quote, editing it, and republishing it on the
 * SAME link.
 *
 * Dean, 2026-09-03: "Hubspot allows you to recall and edit the quote which then
 * updates the actual link sent out. Is this possible through the api?" It is,
 * and the Hub could not do it before: a correction meant a second quote object
 * with a second link while the customer sat holding the first.
 *
 * HubSpot's guide, verbatim: "To modify any properties after you've published a
 * quote, you must first update the hs_status of the quote back to DRAFT,
 * PENDING_APPROVAL, or REJECTED."
 *
 * WHAT THE DOCS DO NOT SAY, and what this whole feature rests on, was verified
 * live against portal 3882358 on 2026-09-03 by reading hs_quote_link's property
 * history on quotes that had been through a full round trip:
 *
 *   - Going back to DRAFT CLEARS hs_quote_link. The customer's url is dead for
 *     as long as the quote sits there (18 and 31 seconds on the two real cases).
 *   - Republishing restores THE SAME url, byte for byte (matching sha256 on
 *     quotes 42646685547 and 42607881765).
 *
 * Because that is undocumented it is also asserted at runtime rather than
 * trusted: publishAndReadBack compares the restored link to link_before_edit and
 * reports a difference instead of hiding it.
 */

export interface EditableQuoteLine {
  productId: string
  name: string
  quantity: number
  /** A PROPOSAL, exactly as in createQuote: honoured only for a SKU with no
   *  Supabase price. The server resolves the price itself otherwise. */
  unitPrice: number
  sku?: string
  description?: string
  discountMode?: DiscountMode
  discountValue?: number
}

export interface RecalledQuote {
  dealQuoteId: string
  dealId: string
  quoteId: string
  quoteNumber: string | null
  title: string | null
  comments: string | null
  currency: string
  expiresOn: string | null
  /** The url the customer already has, which the republish must restore. */
  linkBeforeEdit: string | null
  /** What was quoted, so the builder opens on what the customer is looking at
   *  rather than on whatever the deal says now. */
  lines: PricedCartLine[]
}

export type RecallQuoteResult =
  | { success: true; quote: RecalledQuote }
  | { success: false; error: string }

export type RepublishQuoteResult =
  | {
      success: true
      quote: PublishedQuote
      /** The quote republished but the deal or the registry did not follow, so
       *  invoicing and MRP still hold the old prices. Never silent. */
      resyncError?: string
    }
  | { success: false; error: string; step?: QuoteStep }

interface StoredQuoteRow {
  id: string
  hubspot_deal_id: string
  hubspot_quote_id: string | null
  hs_line_item_ids: string[] | null
  status: string
  title: string | null
  quote_number: string | null
  currency: string | null
  comments: string | null
  contact_id: string | null
  company_id: string | null
  template_key: string | null
  expires_on: string | null
  quote_link: string | null
  pdf_link: string | null
  link_before_edit: string | null
  edit_count: number | null
  hub_amount: string | number | null
  line_items: PricedCartLine[] | null
}

const ROW_COLUMNS =
  'id, hubspot_deal_id, hubspot_quote_id, hs_line_item_ids, status, title, quote_number, currency, comments, contact_id, company_id, template_key, expires_on, quote_link, pdf_link, link_before_edit, edit_count, hub_amount, line_items'

/**
 * Is this deal accepted, and do we actually KNOW?
 *
 * The distinction matters because the accepted check is the only thing standing
 * between an edit and a duplicate Xero quote plus a duplicate MCS contract, so
 * it has to fail CLOSED. getDealDetails returns success:false with no data on a
 * HubSpot 5xx, a missing token or a deal out of scope, and the registry read can
 * come back empty under RLS. Feeding those blanks to isDealAccepted would answer
 * "not accepted" and wave the write through, which is precisely backwards.
 */
async function readAcceptance(
  dealId: string,
): Promise<{ known: boolean; accepted: boolean }> {
  const dealResult = await getDealDetails(dealId)
  const supabase = await createServerClient()
  const { data: registry, error: registryError } = await supabase
    .from('deals_registry')
    .select('deal_status')
    .eq('hubspot_deal_id', dealId)
    .maybeSingle()

  const stage = dealResult?.data?.properties?.dealstage
  const registryStatus = (registry as { deal_status?: string } | null)?.deal_status

  // The registry legitimately has no row for a deal never quoted through the
  // Hub, so an absent row is knowledge, not ignorance. An ERROR reading it is
  // ignorance. The HubSpot side must have answered for the stage to mean
  // anything at all.
  const known = dealResult?.success === true && !!stage && !registryError
  if (!known) {
    console.error('readAcceptance could not determine deal state', {
      dealId,
      dealOk: dealResult?.success,
      registryError: registryError?.message,
    })
  }

  return { known, accepted: isDealAccepted(stage, registryStatus) }
}

/**
 * Record a failed republish step and hand back the message.
 *
 * Always rests the row at 'editing', never 'failed'. There is a real HubSpot
 * quote sitting in DRAFT with no live link at this point, and 'editing' is what
 * holds the one-in-flight index so a fresh Generate cannot orphan it there and
 * mint a second quote on a second link. That row wants republishing.
 */
async function failEdit(
  admin: ReturnType<typeof createAdminClient>,
  dealQuoteId: string,
  step: QuoteStep,
  error: string,
): Promise<RepublishQuoteResult> {
  await failQuoteStep(admin, dealQuoteId, step, error, 'editing')
  return { success: false, error, step }
}

/**
 * Load the row and authorise against ITS deal, not a client-supplied one.
 *
 * The only id the caller passes is the deal_quotes row id, so the deal has to
 * be read off the row before it can be checked. Doing it the other way round
 * would let a caller name their own deal and edit somebody else's quote.
 */
async function loadRowAndAuthorise(
  dealQuoteId: string,
): Promise<{ ok: true; row: StoredQuoteRow } | { ok: false; error: string }> {
  const id = String(dealQuoteId ?? '').trim()
  if (!id) return { ok: false, error: 'No quote was named.' }

  const admin = createAdminClient()
  const { data, error } = await admin.from('deal_quotes').select(ROW_COLUMNS).eq('id', id).maybeSingle()

  if (error) {
    console.error('deal_quotes load failed', error.message)
    return { ok: false, error: 'Could not read that quote. Please try again.' }
  }
  if (!data) return { ok: false, error: 'That quote no longer exists.' }

  const row = data as unknown as StoredQuoteRow
  const access = await assertDealAccess(row.hubspot_deal_id, 'quotes.create')
  if (!access.ok) return { ok: false, error: access.error }

  return { ok: true, row }
}

/**
 * Pull a published quote back to DRAFT so it can be edited.
 *
 * HubSpot blanks hs_quote_link on this transition, so the row's link columns
 * are cleared at the same moment and the old value is kept in link_before_edit.
 * Leaving quote_link populated would leave the deal page offering a url that
 * now 404s.
 */
export async function recallQuoteForEdit(dealQuoteId: string): Promise<RecallQuoteResult> {
  const loaded = await loadRowAndAuthorise(dealQuoteId)
  if (!loaded.ok) return { success: false, error: loaded.error }
  const { row } = loaded

  // The live stage and the registry's own view of it, because the trigger reads
  // one and the deal is described by the other. See recallBlockReason.
  const dealResult = await getDealDetails(row.hubspot_deal_id)
  const supabase = await createServerClient()
  const { data: registry, error: registryError } = await supabase
    .from('deals_registry')
    .select('deal_status')
    .eq('hubspot_deal_id', row.hubspot_deal_id)
    .maybeSingle()

  // Fail closed. Not knowing whether the deal is accepted is not the same as
  // knowing it is not, and guessing wrong here raises a duplicate Xero quote
  // and a duplicate MCS contract further down the line.
  if (!dealResult?.success || !dealResult.data?.properties?.dealstage || registryError) {
    console.error('recallQuoteForEdit could not read deal state', {
      dealId: row.hubspot_deal_id,
      dealOk: dealResult?.success,
      registryError: registryError?.message,
    })
    return {
      success: false,
      error:
        'Could not check this deal in HubSpot, so the quote was left alone. Nothing has changed. Try again in a moment.',
    }
  }

  const blocked = recallBlockReason({
    rowStatus: row.status,
    hubspotQuoteId: row.hubspot_quote_id,
    dealStage: dealResult.data.properties.dealstage,
    registryDealStatus: (registry as { deal_status?: string } | null)?.deal_status,
  })
  if (blocked) return { success: false, error: blocked }

  const quoteId = String(row.hubspot_quote_id).trim()
  const admin = createAdminClient()

  // The CURRENT link first, not the stored one. On a second edit the stored
  // value is the link from before the previous edit, and comparing a republish
  // against that would report a false change the one time it actually matters.
  const linkBeforeEdit = row.quote_link ?? row.link_before_edit ?? null

  // CLAIM THE LOCK BEFORE TOUCHING HUBSPOT.
  //
  // deal_quotes_one_in_flight is unique on hubspot_deal_id where status is
  // draft or editing, and that index is the only thing stopping two in-flight
  // edits on one deal. Done the other way round, recalling a deal's SECOND
  // published quote would pull it to DRAFT in HubSpot (killing its live
  // customer link) and only THEN be refused by the index, leaving a row still
  // marked published, still showing an Open quote button, pointing at a url
  // that now 404s, with nothing in the UI able to republish it.
  const { data: claimed, error: claimError } = await admin
    .from('deal_quotes')
    .update({
      status: 'editing',
      recalled_at: new Date().toISOString(),
      link_before_edit: linkBeforeEdit,
      // HubSpot is about to blank both of these, and the card must not go on
      // offering a link that no longer resolves.
      quote_link: null,
      pdf_link: null,
      failed_step: null,
      error_message: null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', row.id)
    // Only out of 'published'. Two clicks racing each other means the second
    // matches no row rather than recalling an already-recalled quote.
    .eq('status', 'published')
    .select('id')

  if (claimError) {
    if (claimError.code === '23505') {
      return {
        success: false,
        error:
          'Another quote on this deal is already being generated or edited. Finish or republish that one first.',
      }
    }
    console.error('deal_quotes recall claim failed', claimError.message)
    return { success: false, error: 'Could not start the edit. Please try again.' }
  }
  if (!claimed || claimed.length === 0) {
    return { success: false, error: 'That quote is no longer published, so it cannot be recalled.' }
  }

  const response = await hubspotFetch(`${HS}/crm/v3/objects/quotes/${quoteId}`, {
    method: 'PATCH',
    body: JSON.stringify({ properties: { hs_status: QUOTE_DRAFT_STATUS } }),
  })
  if (!response.ok) {
    // HubSpot refused, so the quote is still published and still serving its
    // link. Put the row back exactly as it was: leaving it at 'editing' would
    // hold the lock and hide a link that works perfectly well.
    await admin
      .from('deal_quotes')
      .update({
        status: 'published',
        recalled_at: null,
        quote_link: linkBeforeEdit,
        pdf_link: row.pdf_link ?? null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', row.id)
    return { success: false, error: await readError(response, 'recall') }
  }

  return {
    success: true,
    quote: {
      dealQuoteId: row.id,
      dealId: row.hubspot_deal_id,
      quoteId,
      quoteNumber: row.quote_number,
      title: row.title,
      comments: row.comments,
      currency: row.currency ?? 'USD',
      expiresOn: row.expires_on,
      linkBeforeEdit,
      lines: Array.isArray(row.line_items) ? row.line_items : [],
    },
  }
}

export interface RepublishQuoteInput {
  dealQuoteId: string
  /** Omit to republish the stored snapshot unchanged, which is how the recovery
   *  button on a failed republish works. */
  lines?: EditableQuoteLine[]
  title?: string
  comments?: string
}

/**
 * Republish a recalled quote, on the same link, and bring the deal with it.
 *
 * Order is deliberate. Everything HubSpot needs happens first, so the quote
 * spends the least possible time in DRAFT with a dead link, and the deal and
 * registry re-sync only once the customer-facing document is live again.
 */
export async function republishEditedQuote(input: RepublishQuoteInput): Promise<RepublishQuoteResult> {
  const loaded = await loadRowAndAuthorise(input.dealQuoteId)
  if (!loaded.ok) return { success: false, error: loaded.error }
  const { row } = loaded

  const blocked = republishBlockReason(row.status)
  if (blocked) return { success: false, error: blocked }

  const quoteId = String(row.hubspot_quote_id ?? '').trim()
  if (!quoteId) return { success: false, error: 'That quote has no HubSpot id recorded, so it cannot be republished.' }

  const admin = createAdminClient()
  const supabase = await createServerClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { success: false, error: 'User not authenticated' }

  const { data: profile } = await supabase
    .from('profiles')
    .select('is_super_admin, allowed_depots')
    .eq('id', user.id)
    .maybeSingle()

  const { data: deal } = await getDealDetails(row.hubspot_deal_id)
  const currency = String(row.currency ?? deal?.properties?.deal_currency_code ?? 'USD')
    .trim()
    .toUpperCase()
  const companyId = row.company_id ?? deal?.associations?.companies?.results?.[0]?.id ?? 'UNKNOWN'

  // Re-price from scratch, never from the browser's numbers, exactly as
  // createQuote does. An edit is as much a pricing decision as a first quote,
  // so the discount caps have to be re-checked and not inherited.
  let lines: PricedCartLine[]
  // `undefined` means "republish what is stored", which is how the recovery
  // button works. An EMPTY ARRAY means the rep deleted every line, and must be
  // an error rather than quietly restoring the old ones: createQuote refuses an
  // empty cart for the same reason.
  if (input.lines && input.lines.length === 0) {
    return {
      success: false,
      error: 'A quote needs at least one line item. Add one, or discard the edit and republish it unchanged.',
    }
  }
  if (input.lines) {
    // The same shape check createQuote runs. priceCart never inspects quantity,
    // so without this a crafted call could put a negative or fractional
    // quantity onto the live customer quote and into deals_registry.
    const invalid = validateLineItems(input.lines)
    if (invalid) return { success: false, error: invalid }

    const productIds = input.lines.map((l) => String(l.productId ?? '').trim()).filter(Boolean)
    // The SKU is what decides which price applies, so a failed lookup has to
    // stop the republish rather than fall back to the browser's value.
    const skuResult =
      productIds.length > 0
        ? await getProductSkus(productIds)
        : { success: true as const, data: {} as Record<string, string> }
    if (!skuResult.success) {
      console.error('getProductSkus failed:', skuResult.error)
      return { success: false, error: 'Could not verify products with HubSpot. Please try again.' }
    }
    const skuByProductId: Record<string, string> = skuResult.data ?? {}

    // The depot allow-list, the same control createQuote applies. An edit can
    // introduce a line the original quote never had, so without this a rep
    // could add another region's SKU (EB-SRO's manufacturing codes above all)
    // to an existing quote and republish it.
    //
    // Scoped to the union of the caller's own depots rather than one depot: the
    // fulfilment depot was decided on the deal, not in this form, and this is
    // the same conservative scope createQuote falls back to when no depot has
    // been chosen yet.
    if (!profile?.is_super_admin) {
      const quotedSkus = [
        ...Object.values(skuByProductId),
        ...input.lines.map((l) => l.sku?.trim()).filter((s): s is string => !!s),
      ]
      const scope = await findOutOfScopeSkus(
        supabase,
        quotedSkus,
        (profile?.allowed_depots as string[] | null) ?? [],
      )
      if (!scope.ok) return { success: false, error: scope.error }
      if (scope.wrongDepot.length > 0) {
        return {
          success: false,
          error: `These products are not available from your depots: ${scope.wrongDepot.join(', ')}`,
        }
      }
    }
    const pricing = await loadPricingForQuote({ companyId, currency, userId: user.id })
    const priced = priceCart({
      // The SKU comes from HubSpot, not the browser, with the client value used
      // only where HubSpot has none.
      lines: input.lines.map((l) => ({
        ...l,
        sku: skuByProductId[String(l.productId ?? '').trim()] ?? l.sku,
      })),
      currency,
      companyId,
      listPrices: pricing.listPrices,
      contractPrices: pricing.contractPrices,
      cap: pricing.cap,
      isSuperAdmin: profile?.is_super_admin === true,
      today: new Date().toISOString().slice(0, 10),
    })
    // Before any HubSpot write, so a refused discount leaves the quote exactly
    // as the customer last saw it.
    if (!priced.ok) return { success: false, error: priced.error }
    lines = priced.lines
  } else {
    lines = Array.isArray(row.line_items) ? row.line_items : []
    if (lines.length === 0) {
      return { success: false, error: 'That quote has no line items recorded, so there is nothing to republish.' }
    }
  }

  const hubAmount = lines.reduce((sum, line) => sum + line.lineTotal, 0)
  const title = (input.title ?? row.title ?? 'Quote').trim() || 'Quote'
  const comments = input.comments ?? row.comments ?? null
  // Keep the expiry the customer was given, UNLESS it has already passed.
  // A retry is finishing the same quote and must not silently extend it, but an
  // edit on day 61 would otherwise republish a quote that is expired the moment
  // it goes live, and HubSpot may refuse the past date outright and strand it in
  // draft with the link offline.
  const today = new Date().toISOString().slice(0, 10)
  const storedExpiry = row.expires_on ?? ''
  const expiresOn = storedExpiry && storedExpiry >= today ? storedExpiry : quoteExpiryDate(today)

  const ctx: PublishQuoteContext = {
    dealId: row.hubspot_deal_id,
    title,
    currency,
    templateKey: row.template_key ?? '',
    contactId: row.contact_id,
    companyId: companyId === 'UNKNOWN' ? null : companyId,
    comments,
    quoteNumber: row.quote_number ?? undefined,
    // The sender block is already on the quote; an edit never re-sends it.
    sender: {},
    lines,
    hubAmount,
    createdByUid: user.id,
    createdByLabel: user.email ?? 'Hub user',
  }

  // Step 1. Swap the quote's line items for the edited set.
  //
  // Archive then recreate, the same shape addLineItemsToDeal uses on the deal,
  // because HubSpot has no "replace these" call. These are the QUOTE's own
  // copies, which is why archiving them does not touch the deal's.
  const oldLineItemIds = (row.hs_line_item_ids ?? []).filter(Boolean)
  let lineItemIds: string[] = []
  {
    const inputs = buildQuoteLineItemInputs(
      lines.map((line) => ({
        name: line.name,
        quantity: line.quantity,
        price: line.priced.hubspot.price,
        hs_discount_percentage: line.priced.hubspot.hs_discount_percentage ?? null,
        discount: line.priced.hubspot.discount ?? null,
        hs_product_id: line.productId,
        hs_sku: line.sku,
        description: line.description,
      })),
      currency,
    )
    const created = await hubspotFetch(`${HS}/crm/v3/objects/line_items/batch/create`, {
      method: 'POST',
      body: JSON.stringify({ inputs }),
    })
    if (!created.ok) {
      return failEdit(admin, row.id, 'replace_line_items', await readError(created, 'replace_line_items'))
    }
    const body = (await created.json()) as { results: { id: string }[] }
    lineItemIds = body.results.map((r) => r.id)

    // Recorded BEFORE the old ones are archived, so a crash here leaves ids
    // that can be cleaned up rather than line items nothing references. Checked,
    // because a silent failure here would leave the row pointing at the OLD ids:
    // the next edit would then archive live items and leave these ones on the
    // quote for good.
    const { error: idsError } = await admin
      .from('deal_quotes')
      .update({ hs_line_item_ids: lineItemIds, updated_at: new Date().toISOString() })
      .eq('id', row.id)
    if (idsError) {
      console.error('deal_quotes line item id write failed', idsError.message)
      return failEdit(
        admin,
        row.id,
        'replace_line_items',
        'The new line items were created in HubSpot but the Hub could not record them, so the quote was not republished. Try again.',
      )
    }

    if (oldLineItemIds.length > 0) {
      const archived = await hubspotFetch(`${HS}/crm/v3/objects/line_items/batch/archive`, {
        method: 'POST',
        body: JSON.stringify({ inputs: oldLineItemIds.map((id) => ({ id })) }),
      })
      // This MUST block the republish. Associating the new items does not
      // detach the old ones, so publishing now would show the customer both
      // sets of lines and roughly double the total. Better a quote that stays
      // in draft for another minute than a wrong one that goes live.
      if (!archived.ok) {
        console.error('republishEditedQuote archive failed', {
          quoteId,
          ids: oldLineItemIds,
          status: archived.status,
        })
        return failEdit(
          admin,
          row.id,
          'replace_line_items',
          `The previous line items could not be removed from the quote, so it was not republished. Publishing now would show the customer both the old and the new lines. ${await readError(archived, 'replace_line_items')}`,
        )
      }
    }
  }

  // Step 2. The quote's own editable properties. Never hs_quote_number: it is
  // the same quote object, so the number the customer already has stays right.
  {
    const properties: Record<string, string> = {
      hs_title: title,
      hs_expiration_date: expiresOn,
    }
    if (comments != null) properties.hs_comments = commentsToHtml(comments)
    const patched = await hubspotFetch(`${HS}/crm/v3/objects/quotes/${quoteId}`, {
      method: 'PATCH',
      body: JSON.stringify({ properties }),
    })
    if (!patched.ok) {
      return failEdit(admin, row.id, 'publish', await readError(patched, 'publish'))
    }
  }

  // Step 3. Associate, republish, read the link back, and assert it is the same
  // url the customer was sent.
  const published = await publishAndReadBack(admin, row.id, quoteId, lineItemIds, ctx, expiresOn, {
    expectLink: row.link_before_edit,
    failStatus: 'editing',
    extraRowFields: {
      edited_at: new Date().toISOString(),
      edit_count: (row.edit_count ?? 0) + 1,
      hub_amount: hubAmount,
      line_items: lines,
      title,
      comments,
      // Stored too, or the card would keep showing the old date after an
      // expired quote was republished with a fresh one.
      expires_on: expiresOn,
    },
  })
  if (!published.success) return published as RepublishQuoteResult

  // Step 4. Bring the deal and the registry with it, Dean's call: without this
  // the customer sees the new price while invoicing, the Xero trigger and MRP
  // still bill the old one.
  //
  // The accepted check is repeated HERE, not just at recall. An edit is a
  // human-paced thing and the deal can be accepted while it is open, in which
  // case the recall-time check is stale and writing line_items_raw would fire
  // notify_quote_accepted() into a second Xero quote and a second MCS contract.
  // The quote itself is already republished by this point, so the link is safe
  // either way and only the registry write is withheld.
  // Fails CLOSED: if the deal's state cannot be read, the registry is left
  // alone rather than written on an optimistic guess.
  const acceptance = await readAcceptance(row.hubspot_deal_id)
  const resyncError = acceptance.accepted
    ? ACCEPTED_MID_EDIT_MESSAGE
    : !acceptance.known
      ? 'The quote was republished on its original link, but this deal could not be checked in HubSpot, so the deal and the Hub database were left alone rather than risk re-raising Xero and MCS documents. Regenerate the quote once HubSpot is reachable to bring them back in step.'
      : await resyncDeal(row.hubspot_deal_id, lines, currency, hubAmount)

  return resyncError
    ? { success: true, quote: published.quote, resyncError }
    : { success: true, quote: published.quote }
}

/**
 * Replace the DEAL's line items, correct its amount, and update its registry row
 * to match the quote.
 *
 * Only ever reached for a deal that is NOT at Quotation Accepted: the caller
 * short-circuits on an accepted deal so that repricing can never re-fire the
 * Xero quote or the MCS contract. Dean's call, and the reason the amount write
 * below needs no guard of its own.
 *
 * Returns an error string rather than throwing: the quote is already live at
 * this point, so a failure here is a warning to carry back, not a reason to
 * pretend the republish failed.
 */
async function resyncDeal(
  dealId: string,
  lines: PricedCartLine[],
  currency: string,
  hubAmount: number,
): Promise<string | undefined> {
  const result = await addLineItemsToDeal(
    dealId,
    lines.map((l) => ({
      productId: l.productId,
      name: l.name,
      quantity: l.quantity,
      // The base, with the discount as its own property: HubSpot derives the
      // line amount itself and would otherwise discount the net twice.
      unitPrice: l.priced.hubspot.price,
      total: l.lineTotal,
      sku: l.sku,
      description: l.description,
      discountPercentage: l.priced.hubspot.hs_discount_percentage,
      discountPerUnit: l.priced.hubspot.discount,
    })),
    currency,
  )
  if (!result.success) {
    return 'The quote was republished, but the deal line items in HubSpot could not be updated, so invoicing still holds the old prices.'
  }

  // The deal's own amount, which nothing else on this path updates. HubSpot does
  // not derive it from the line items in this portal (deal 64665124513 read $100
  // against $1,100 of lines), so it has to be written explicitly or the deal
  // keeps the first version's total for good.
  //
  // Collected rather than returned: the quote is already live and its line items
  // are already correct, so a stale amount on the deal is worth a warning, not a
  // failure the rep cannot act on.
  const amountResult = await updateDealAmount(dealId, hubAmount)
  const amountWarning = amountResult.success
    ? undefined
    : 'The quote was republished and its line items updated, but the deal amount in HubSpot still shows the previous total. Change it on the deal, or regenerate the quote.'

  const dealLineItemIds = result.lineItemIds ?? []
  const supabase = await createServerClient()
  // UPDATE, not upsert. The row already exists (the original generate made it)
  // and an upsert would have to supply deal_status, which is NOT NULL and is
  // owned by the n8n stage sync. Writing it here would clobber the synced stage.
  const { data: updated, error } = await supabase
    .from('deals_registry')
    .update({
      amount: hubAmount,
      line_items_raw: lines.map((line, i) => toRegistryLine(line, dealLineItemIds[i])),
      updated_at: new Date().toISOString(),
    })
    .eq('hubspot_deal_id', dealId)
    // Selected back so a write that matched NOTHING is caught. An RLS UPDATE
    // policy filters rows, it does not raise, so a rep whose pipeline does not
    // match the deal's gets error:null and zero rows. assertDealAccess admits a
    // rep on owner match even across pipelines (deliberately, for inbound Demo
    // deals), so this is reachable, and without the check they would be told
    // everything synced while invoicing kept billing the old prices.
    .select('hubspot_deal_id')

  if (error) {
    console.error('republishEditedQuote registry resync failed', error.message)
    return 'The quote and the HubSpot deal were updated, but the Hub database was not, so invoicing may still hold the old prices.'
  }

  if (!updated || updated.length === 0) {
    console.error('republishEditedQuote registry resync matched no rows', { dealId })
    return 'The quote and the HubSpot deal were updated, but the Hub database row for this deal was not (it may sit outside your region), so invoicing still holds the old prices. Ask an admin to re-sync it.'
  }

  return amountWarning
}
