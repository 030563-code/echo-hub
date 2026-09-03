'use server'

import { createAdminClient } from '@/lib/supabase/admin'
import { assertDealAccess } from '@/lib/authz'
import { hubspotFetch } from '@/lib/hubspot-client'
import { quoteTemplateIdFor } from '@/lib/pipeline-config'
import {
  QUOTE_ASSOCIATION_TYPE_IDS,
  QUOTE_PUBLISHED_STATUS,
  QUOTE_READBACK_PROPERTIES,
  buildQuoteCreateBody,
  buildQuoteLineItemInputs,
  quoteExpiryDate,
  validateQuoteInput,
} from '@/lib/hubspot-quote'
import type { PricedCartLine } from '@/lib/quote-pricing'

/**
 * Creating and publishing a real HubSpot Quote object.
 *
 * This replaces the jsPDF document the Hub used to render and upload. Dean's
 * words: "a complete flip on how we do the quoting now we are doing the Quote
 * creation through hubspot api instead. Where it should return a hubspot quote
 * link on info.echobarrier.com".
 *
 * ORDER MATTERS AND IS NOT THE OBVIOUS ONE. The quote is created first, with
 * its template, deal, contact and company, and its line items are created and
 * associated afterwards. Two reasons. The likeliest failure is a rejected
 * create, and it then happens before any line item exists rather than leaving
 * orphans nothing points at. And every later failure leaves a DRAFT quote
 * visible on the deal, which the retry resumes instead of rebuilding.
 *
 * A deal_quotes row is written BEFORE the first HubSpot call and updated at
 * every step, so the row is the resume state. A partial unique index on it
 * refuses a second in-flight generate for the same deal, which the builder's
 * own submit guard cannot do because that is client state and dies on refresh.
 */

const HS = 'https://api.hubapi.com'

export type QuoteStep =
  | 'create_quote'
  | 'create_line_items'
  | 'associate_line_items'
  | 'publish'
  | 'read_back'

export interface PublishedQuote {
  dealQuoteId: string
  quoteId: string
  quoteNumber: string | null
  quoteLink: string | null
  pdfLink: string | null
  amount: number | null
  hubAmount: number
  /** Set when HubSpot's own total disagrees with the Hub's by more than a cent.
   *  Surfaced, never silently accepted: the customer sees HubSpot's number. */
  amountMismatch: boolean
  expiresOn: string
}

export type PublishQuoteResult =
  | { success: true; quote: PublishedQuote }
  | { success: false; error: string; dealQuoteId?: string; step?: QuoteStep }

export interface PublishQuoteContext {
  dealId: string
  title: string
  currency: string
  templateKey: string
  contactId: string | null
  companyId: string | null
  comments?: string | null
  quoteNumber?: string
  sender: { firstname?: string | null; lastname?: string | null; email?: string | null; phone?: string | null }
  lines: readonly PricedCartLine[]
  hubAmount: number
  createdByUid: string
  createdByLabel: string
}

/** HubSpot bodies can be long; the column is text but the UI is not. */
function short(text: string): string {
  return text.length > 2000 ? `${text.slice(0, 2000)}...` : text
}

async function readError(response: Response, step: QuoteStep): Promise<string> {
  const body = await response.text().catch(() => '')
  console.error(`publishQuote ${step} failed`, response.status, body)
  return short(body || `HubSpot returned ${response.status}`)
}

/**
 * Run the quote pipeline, resuming from an existing row when there is one.
 *
 * Steps 4 to 6 are safe to repeat: re-associating a pair HubSpot already holds
 * is accepted, publishing an already published quote is a no-op, and the read
 * back is a GET.
 */
export async function runQuotePipeline(ctx: PublishQuoteContext): Promise<PublishQuoteResult> {
  const admin = createAdminClient()
  const templateId = quoteTemplateIdFor(ctx.templateKey)
  if (!templateId) {
    return {
      success: false,
      error: `No HubSpot quote template is set up for "${ctx.templateKey}", so the quote cannot be branded or published. Ask for one to be mapped.`,
    }
  }

  const expiresOn = quoteExpiryDate(new Date().toISOString().slice(0, 10))
  const createInput = {
    title: ctx.title,
    expirationDate: expiresOn,
    quoteNumber: ctx.quoteNumber,
    comments: ctx.comments,
    sender: ctx.sender,
    templateId,
    dealId: ctx.dealId,
    contactId: ctx.contactId,
    companyId: ctx.companyId,
  }
  const invalid = validateQuoteInput(createInput, ctx.lines.length)
  if (invalid) return { success: false, error: invalid }

  // Step 0. Claim the deal before touching HubSpot. A unique violation here is
  // a second Generate racing the first, not an error worth a stack trace.
  const { data: claimed, error: claimError } = await admin
    .from('deal_quotes')
    .insert({
      hubspot_deal_id: ctx.dealId,
      status: 'draft',
      title: ctx.title,
      quote_number: ctx.quoteNumber ?? null,
      currency: ctx.currency,
      template_key: ctx.templateKey,
      template_id: templateId,
      expires_on: expiresOn,
      comments: ctx.comments ?? null,
      contact_id: ctx.contactId,
      company_id: ctx.companyId,
      hub_amount: ctx.hubAmount,
      line_items: ctx.lines,
      created_by_uid: ctx.createdByUid,
      created_by_label: ctx.createdByLabel,
    })
    .select('id')
    .single()

  if (claimError || !claimed) {
    if (claimError?.code === '23505') {
      return {
        success: false,
        error: 'A quote is already being generated for this deal. Give it a moment, then use Retry quote.',
      }
    }
    console.error('deal_quotes claim failed', claimError?.message)
    return { success: false, error: 'Could not start the quote. Please try again.' }
  }

  return runFromRow(admin, (claimed as { id: string }).id, ctx, templateId, expiresOn, createInput)
}

type Admin = ReturnType<typeof createAdminClient>

async function fail(
  admin: Admin,
  dealQuoteId: string,
  step: QuoteStep,
  error: string,
): Promise<PublishQuoteResult> {
  await admin
    .from('deal_quotes')
    .update({ status: 'failed', failed_step: step, error_message: error, updated_at: new Date().toISOString() })
    .eq('id', dealQuoteId)
  return { success: false, error, dealQuoteId, step }
}

async function runFromRow(
  admin: Admin,
  dealQuoteId: string,
  ctx: PublishQuoteContext,
  templateId: string,
  expiresOn: string,
  createInput: Parameters<typeof buildQuoteCreateBody>[0],
  existing?: { hubspot_quote_id?: string | null; hs_line_item_ids?: string[] | null },
): Promise<PublishQuoteResult> {
  let quoteId = String(existing?.hubspot_quote_id ?? '').trim()
  let lineItemIds = (existing?.hs_line_item_ids ?? []).filter(Boolean)

  // Step 1 and 2. The quote, with the template association that can only be
  // set now.
  if (!quoteId) {
    const response = await hubspotFetch(`${HS}/crm/v3/objects/quotes`, {
      method: 'POST',
      body: JSON.stringify(buildQuoteCreateBody(createInput)),
    })
    if (!response.ok) return fail(admin, dealQuoteId, 'create_quote', await readError(response, 'create_quote'))
    const created = (await response.json()) as { id: string }
    quoteId = created.id
    await admin
      .from('deal_quotes')
      .update({ hubspot_quote_id: quoteId, updated_at: new Date().toISOString() })
      .eq('id', dealQuoteId)
  }

  // Step 3. The quote's OWN line items. HubSpot's guide is explicit that these
  // must be copies: sharing the deal's would make an edit on the quote rewrite
  // the deal.
  if (lineItemIds.length === 0) {
    const inputs = buildQuoteLineItemInputs(
      ctx.lines.map((line) => ({
        name: line.name,
        quantity: line.quantity,
        price: line.priced.hubspot.price,
        hs_discount_percentage: line.priced.hubspot.hs_discount_percentage ?? null,
        discount: line.priced.hubspot.discount ?? null,
        hs_product_id: line.productId,
        hs_sku: line.sku,
        description: line.description,
      })),
      ctx.currency,
    )
    const response = await hubspotFetch(`${HS}/crm/v3/objects/line_items/batch/create`, {
      method: 'POST',
      body: JSON.stringify({ inputs }),
    })
    if (!response.ok) return fail(admin, dealQuoteId, 'create_line_items', await readError(response, 'create_line_items'))
    const created = (await response.json()) as { results: { id: string }[] }
    lineItemIds = created.results.map((r) => r.id)
    await admin
      .from('deal_quotes')
      .update({ hs_line_item_ids: lineItemIds, updated_at: new Date().toISOString() })
      .eq('id', dealQuoteId)
  }

  // Step 4. Attach them. Re-associating a pair HubSpot already holds is
  // accepted, so a retry through here is harmless.
  {
    const response = await hubspotFetch(`${HS}/crm/v4/associations/quotes/line_items/batch/create`, {
      method: 'POST',
      body: JSON.stringify({
        inputs: lineItemIds.map((id) => ({
          from: { id: quoteId },
          to: { id },
          types: [
            {
              associationCategory: 'HUBSPOT_DEFINED',
              associationTypeId: QUOTE_ASSOCIATION_TYPE_IDS.lineItem,
            },
          ],
        })),
      }),
    })
    if (!response.ok) {
      return fail(admin, dealQuoteId, 'associate_line_items', await readError(response, 'associate_line_items'))
    }
  }

  // Step 5. Publish. The guide: APPROVAL_NOT_NEEDED "publishes the quote at a
  // publicly accessible URL (hs_quote_link)".
  {
    const response = await hubspotFetch(`${HS}/crm/v3/objects/quotes/${quoteId}`, {
      method: 'PATCH',
      body: JSON.stringify({ properties: { hs_status: QUOTE_PUBLISHED_STATUS } }),
    })
    if (!response.ok) return fail(admin, dealQuoteId, 'publish', await readError(response, 'publish'))
  }

  // Step 6. Read back the link. HubSpot generates it during the state change
  // and it is not always there on the first GET.
  let props: Record<string, string | null> = {}
  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await hubspotFetch(
      `${HS}/crm/v3/objects/quotes/${quoteId}?properties=${QUOTE_READBACK_PROPERTIES.join(',')}`,
    )
    if (!response.ok) return fail(admin, dealQuoteId, 'read_back', await readError(response, 'read_back'))
    props = ((await response.json()) as { properties: Record<string, string | null> }).properties ?? {}
    if (props.hs_quote_link) break
    if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 700))
  }

  const amount = props.hs_quote_amount == null ? null : Number(props.hs_quote_amount)
  // A cent of drift between HubSpot's rounding and ours is worth showing, not
  // worth failing: the customer sees HubSpot's figure either way.
  const amountMismatch = amount != null && Math.abs(amount - ctx.hubAmount) > 0.01
  if (amountMismatch) {
    console.warn('publishQuote amount mismatch', { quoteId, hubspot: amount, hub: ctx.hubAmount })
  }

  await admin
    .from('deal_quotes')
    .update({
      status: 'published',
      failed_step: null,
      error_message: null,
      quote_link: props.hs_quote_link ?? null,
      pdf_link: props.hs_pdf_download_link ?? null,
      quote_number: props.hs_quote_number ?? ctx.quoteNumber ?? null,
      amount,
      updated_at: new Date().toISOString(),
    })
    .eq('id', dealQuoteId)

  return {
    success: true,
    quote: {
      dealQuoteId,
      quoteId,
      quoteNumber: props.hs_quote_number ?? ctx.quoteNumber ?? null,
      quoteLink: props.hs_quote_link ?? null,
      pdfLink: props.hs_pdf_download_link ?? null,
      amount,
      hubAmount: ctx.hubAmount,
      amountMismatch,
      expiresOn,
    },
  }
}

/**
 * Retry a generate that stopped part way, resuming from the first incomplete
 * step rather than minting a second quote.
 *
 * Called from the builder and from the deal page. The stored line_items
 * snapshot is what it rebuilds from, so a retry quotes exactly what the rep
 * approved, not whatever the deal looks like now.
 */
export async function retryHubSpotQuote(dealId: string): Promise<PublishQuoteResult> {
  const access = await assertDealAccess(dealId, 'quotes.create')
  if (!access.ok) return { success: false, error: access.error }

  const admin = createAdminClient()
  const { data: row } = await admin
    .from('deal_quotes')
    .select('*')
    .eq('hubspot_deal_id', dealId)
    .in('status', ['draft', 'failed'])
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (!row) {
    return {
      success: false,
      error: 'There is no unfinished quote on this deal. Open the builder and generate a new one.',
    }
  }

  const stored = row as {
    id: string
    hubspot_quote_id: string | null
    hs_line_item_ids: string[] | null
    title: string | null
    currency: string | null
    template_key: string | null
    template_id: string | null
    expires_on: string | null
    comments: string | null
    contact_id: string | null
    company_id: string | null
    hub_amount: string | number | null
    line_items: PricedCartLine[] | null
    created_by_uid: string | null
    created_by_label: string | null
    quote_number: string | null
  }

  const templateId = stored.template_id ?? quoteTemplateIdFor(stored.template_key)
  if (!templateId) {
    return { success: false, error: 'That quote has no HubSpot template recorded, so it cannot be republished.' }
  }
  const lines = Array.isArray(stored.line_items) ? stored.line_items : []
  if (lines.length === 0) {
    return { success: false, error: 'That quote has no line items recorded. Generate a new one from the builder.' }
  }

  // Reuse the ORIGINAL expiry: a retry is finishing the same quote, not issuing
  // a fresh one with a later date than the rep agreed.
  const expiresOn = stored.expires_on ?? quoteExpiryDate(new Date().toISOString().slice(0, 10))
  const ctx: PublishQuoteContext = {
    dealId,
    title: stored.title ?? 'Quote',
    currency: stored.currency ?? 'USD',
    templateKey: stored.template_key ?? '',
    contactId: stored.contact_id,
    companyId: stored.company_id,
    comments: stored.comments,
    quoteNumber: stored.quote_number ?? undefined,
    sender: {},
    lines,
    hubAmount: Number(stored.hub_amount ?? 0),
    createdByUid: stored.created_by_uid ?? '',
    createdByLabel: stored.created_by_label ?? '',
  }

  // Back to draft so the in-flight index still describes reality while this runs.
  await admin
    .from('deal_quotes')
    .update({ status: 'draft', failed_step: null, error_message: null, updated_at: new Date().toISOString() })
    .eq('id', stored.id)

  return runFromRow(
    admin,
    stored.id,
    ctx,
    templateId,
    expiresOn,
    {
      title: ctx.title,
      expirationDate: expiresOn,
      quoteNumber: ctx.quoteNumber,
      comments: ctx.comments,
      // The sender block is already on the quote when one exists; a resume that
      // never reaches the create step does not need it, and one that does is a
      // quote HubSpot rejected outright.
      sender: {},
      templateId,
      dealId,
      contactId: ctx.contactId,
      companyId: ctx.companyId,
    },
    { hubspot_quote_id: stored.hubspot_quote_id, hs_line_item_ids: stored.hs_line_item_ids },
  )
}
