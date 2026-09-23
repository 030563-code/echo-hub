import 'server-only'

import { createAdminClient } from '@/lib/supabase/admin'
import { hubspotFetch } from '@/lib/hubspot-client'
import { quoteTemplateIdFor, QUOTE_BRANDING } from '@/lib/pipeline-config'
import {
  buildQuoteCreateBody,
  buildQuoteLineItemInputs,
  QUOTE_ASSOCIATION_TYPE_IDS,
  QUOTE_PUBLISHED_STATUS,
  QUOTE_READBACK_PROPERTIES,
  quoteExpiryDate,
  validateQuoteInput,
} from '@/lib/hubspot-quote'
import type { PricedCartLine } from '@/lib/quote-pricing'

/**
 * The shared tail of publishing a HubSpot quote: associate, publish, read back,
 * record.
 *
 * Lives here rather than in a `'use server'` file on purpose. These helpers
 * take the service-role Supabase client as an argument and write to
 * deal_quotes without a capability check of their own, because their callers
 * have already done that. Exported from a `'use server'` module they would each
 * become a real server action, addressable by anything that can guess an action
 * id, which is exactly the IDOR shape the sales-hub audit found. `server-only`
 * makes them plain server functions instead, and makes a client import a build
 * error rather than a runtime surprise.
 *
 * Both the first publish (runQuotePipeline) and a republish after an edit
 * (republishEditedQuote) run this same tail, so the retry loop, the
 * amount-mismatch check and the row bookkeeping exist once.
 */

export const HS = 'https://api.hubapi.com'

export type Admin = ReturnType<typeof createAdminClient>

export type QuoteStep =
  | 'create_quote'
  | 'create_line_items'
  | 'associate_line_items'
  | 'publish'
  | 'read_back'
  /** Edit only: pulling a published quote back to DRAFT so it can be changed. */
  | 'recall'
  /** Edit only: swapping the quote's line items for the edited set. */
  | 'replace_line_items'
  /** Edit only: re-syncing the deal and deals_registry after a republish. */
  | 'resync_deal'

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
  /**
   * Edit only. True when a republished quote came back on a DIFFERENT url to
   * the one the customer was already sent.
   *
   * Verified on 2026-09-03 that HubSpot reissues the same link, but its docs do
   * not promise it, so this is the tripwire rather than an assumption. When it
   * is true somebody has to resend the link, so it is surfaced, never swallowed.
   */
  linkChanged: boolean
}

/**
 * A machine-readable reason a publish refused, for the few cases a caller has
 * to branch on rather than show.
 *
 * IN_FLIGHT is the one-in-flight unique index (23505): another generate or an
 * edit already owns this deal. The agent route answers it with its own
 * IN_PROGRESS code instead of retrying, because a retry would resume THAT row.
 * Matching on the sentence would have been a string compare on rep-facing text.
 */
export type PublishFailureCode = 'IN_FLIGHT'

export type PublishQuoteResult =
  | { success: true; quote: PublishedQuote }
  | { success: false; error: string; code?: PublishFailureCode; dealQuoteId?: string; step?: QuoteStep }

/**
 * Extra columns an AGENT quote carries. Absent for every quote a person raises,
 * and then no column is written, so the rep path is untouched by this and does
 * not depend on the columns existing.
 */
export interface AgentQuoteStamp {
  /** 'list' or 'urgent'. Recorded even for 'list' so the reissue check can read
   *  the newest Jack row and tell the two apart without inference. */
  pricingMode: 'list' | 'urgent' | 'negotiated'
  /** ISO, created time plus 24 hours. Urgent only; null on a list quote. */
  acceptBy: string | null
  /** The urgent deal_quotes row this quote reissues at standard prices. */
  reissueOf: string | null
  /** What the caller said made the job urgent, as the agent heard it. The
   *  AUDIT of why a floor price was offered, and nothing else: it is never
   *  printed on the quote and never emailed. Null on a list quote. */
  urgencyNote: string | null
}

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
  /** The rep's HubSpot owner id, for hs_quote_owner_id. Null when unknown. */
  ownerId?: string | null
  lines: readonly PricedCartLine[]
  hubAmount: number
  createdByUid: string
  createdByLabel: string
  /** An explicit yyyy-mm-dd hs_expiration_date. Omitted means the house default
   *  (today plus QUOTE_EXPIRY_DAYS, 60). Only an urgent agent quote passes one,
   *  and it passes the SYDNEY date of its acceptance deadline: a day count off
   *  the UTC date would expire the quote a calendar day before the deadline
   *  printed on it whenever it is raised before 10am in Sydney. */
  expiryDate?: string
  agentQuote?: AgentQuoteStamp
}

/** HubSpot bodies can be long; the column is text but the UI is not. */
export function short(text: string): string {
  return text.length > 2000 ? `${text.slice(0, 2000)}...` : text
}

export async function readError(response: Response, step: QuoteStep): Promise<string> {
  const body = await response.text().catch(() => '')
  console.error(`publishQuote ${step} failed`, response.status, body)
  return short(body || `HubSpot returned ${response.status}`)
}

/**
 * Record a failed step on the row and return the error.
 *
 * `status` is a parameter because the two flows want different resting states.
 * A failed GENERATE goes to 'failed', which releases the one-in-flight lock so
 * the rep can start over. A failed REPUBLISH stays at 'editing' and KEEPS the
 * lock: there is a real HubSpot quote sitting in DRAFT with no live link, and
 * letting a fresh Generate through would orphan it there while minting a second
 * quote and a second link. That row needs republishing, not replacing.
 */
export async function failQuoteStep(
  admin: Admin,
  dealQuoteId: string,
  step: QuoteStep,
  error: string,
  status: 'failed' | 'editing' = 'failed',
): Promise<PublishQuoteResult> {
  await admin
    .from('deal_quotes')
    .update({ status, failed_step: step, error_message: error, updated_at: new Date().toISOString() })
    .eq('id', dealQuoteId)
  return { success: false, error, dealQuoteId, step }
}

export interface PublishTailOptions {
  /**
   * The link the customer already holds, on an edit. The restored link is
   * compared against it and any difference is reported rather than hidden.
   * Absent on a first publish, where there is nothing to compare to.
   */
  expectLink?: string | null
  /** Extra columns to write alongside the success update, e.g. the edit stamps. */
  extraRowFields?: Record<string, unknown>
  /** Resting status for a failure here. See failQuoteStep. */
  failStatus?: 'failed' | 'editing'
}

/**
 * Associate the line items, publish, read the link back, and record the result.
 *
 * Every step is safe to repeat: re-associating a pair HubSpot already holds is
 * accepted, publishing an already published quote is a no-op, and the read back
 * is a GET. That is what makes both Retry and Republish safe to press twice.
 */
export async function publishAndReadBack(
  admin: Admin,
  dealQuoteId: string,
  quoteId: string,
  lineItemIds: string[],
  ctx: PublishQuoteContext,
  expiresOn: string,
  options: PublishTailOptions = {},
): Promise<PublishQuoteResult> {
  const failStatus = options.failStatus ?? 'failed'

  // Step 4. Attach the line items.
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
      return failQuoteStep(
        admin,
        dealQuoteId,
        'associate_line_items',
        await readError(response, 'associate_line_items'),
        failStatus,
      )
    }
  }

  // Step 5. Publish. The guide: APPROVAL_NOT_NEEDED "publishes the quote at a
  // publicly accessible URL (hs_quote_link)".
  {
    const response = await hubspotFetch(`${HS}/crm/v3/objects/quotes/${quoteId}`, {
      method: 'PATCH',
      body: JSON.stringify({ properties: { hs_status: QUOTE_PUBLISHED_STATUS } }),
    })
    if (!response.ok) {
      return failQuoteStep(admin, dealQuoteId, 'publish', await readError(response, 'publish'), failStatus)
    }
  }

  // Step 6. Read back the link. HubSpot generates it during the state change
  // and it is not always there on the first GET: 7 of the first 10 published
  // quotes came back without one inside three reads 700ms apart, and the
  // rep's Copy link button did nothing. Up to eight reads over about ten
  // seconds here, and the deal page fills any that are still missing
  // (backfillQuoteLinks) the next time it renders.
  let props: Record<string, string | null> = {}
  for (let attempt = 0; attempt < 8; attempt++) {
    const response = await hubspotFetch(
      `${HS}/crm/v3/objects/quotes/${quoteId}?properties=${QUOTE_READBACK_PROPERTIES.join(',')}`,
    )
    if (!response.ok) {
      return failQuoteStep(admin, dealQuoteId, 'read_back', await readError(response, 'read_back'), failStatus)
    }
    props = ((await response.json()) as { properties: Record<string, string | null> }).properties ?? {}
    if (props.hs_quote_link) break
    if (attempt < 7) await new Promise((resolve) => setTimeout(resolve, 1500))
  }

  const amount = props.hs_quote_amount == null ? null : Number(props.hs_quote_amount)
  // A cent of drift between HubSpot's rounding and ours is worth showing, not
  // worth failing: the customer sees HubSpot's figure either way.
  const amountMismatch = amount != null && Math.abs(amount - ctx.hubAmount) > 0.01
  if (amountMismatch) {
    console.warn('publishQuote amount mismatch', { quoteId, hubspot: amount, hub: ctx.hubAmount })
  }

  const restoredLink = props.hs_quote_link ?? null
  const expected = String(options.expectLink ?? '').trim()

  // On an EDIT, coming back with no link at all is a failure, not a success.
  // The customer's url was live before the recall and is not live now, and
  // reporting "republished on the same link" while storing a null link would
  // both lie to the rep and throw away link_before_edit, the only record of
  // what the customer is holding. Left at the caller's failStatus so the row
  // keeps the lock and the Republish button stays available.
  if (expected !== '' && restoredLink === null) {
    console.error('republishQuote came back with no link', { quoteId, dealQuoteId })
    return failQuoteStep(
      admin,
      dealQuoteId,
      'read_back',
      'HubSpot republished the quote but did not give a link back, so the customer link is still offline. Press Republish again in a moment.',
      failStatus,
    )
  }

  // Only meaningful on an edit; a first publish has no earlier link to differ
  // from.
  const linkChanged = expected !== '' && restoredLink !== null && restoredLink !== expected
  if (linkChanged) {
    console.error('republishQuote link changed', { quoteId, dealQuoteId })
  }

  await admin
    .from('deal_quotes')
    .update({
      status: 'published',
      failed_step: null,
      error_message: null,
      quote_link: restoredLink,
      pdf_link: props.hs_pdf_download_link ?? null,
      quote_number: props.hs_quote_number ?? ctx.quoteNumber ?? null,
      amount,
      updated_at: new Date().toISOString(),
      ...(options.extraRowFields ?? {}),
    })
    .eq('id', dealQuoteId)

  return {
    success: true,
    quote: {
      dealQuoteId,
      quoteId,
      quoteNumber: props.hs_quote_number ?? ctx.quoteNumber ?? null,
      quoteLink: restoredLink,
      pdfLink: props.hs_pdf_download_link ?? null,
      amount,
      hubAmount: ctx.hubAmount,
      amountMismatch,
      expiresOn,
      linkChanged,
    },
  }
}

/**
 * Creating and publishing a real HubSpot Quote object.
 *
 * MOVED OUT OF A 'use server' FILE, 2026-09-16. runQuotePipeline was an export
 * of src/app/actions/sales/publish-quote.ts, so it was a callable server action
 * that took its whole context from the caller: deal id, lines, prices, sender
 * name and createdByUid, with no capability check of its own. Any signed-in
 * account could publish a real HubSpot quote on any deal with the server's
 * token and write a deal_quotes row. It is reached only through createQuote,
 * which does gate, so nothing about the flow changes; it simply stops being
 * addressable. The file's own comment already said the runtime helpers must not
 * come back out of that module.
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

  // The expiry date is an override now, defaulting to the house 60 days from
  // the UTC date the moment it is omitted, so every existing caller keeps the
  // expiry it had. Only the agent's urgent quote passes one, and it passes a
  // DATE rather than a day count because its deadline is an instant in Sydney:
  // a count off the UTC date expires the quote a calendar day early for the
  // whole Sydney morning. An unparseable override is caught by
  // validateQuoteInput below, before the row is claimed or HubSpot is called.
  const expiresOn = ctx.expiryDate ?? quoteExpiryDate(new Date().toISOString().slice(0, 10))
  const createInput = {
    title: ctx.title,
    expirationDate: expiresOn,
    quoteNumber: ctx.quoteNumber,
    comments: ctx.comments,
    sender: ctx.sender,
    ownerId: ctx.ownerId ?? null,
    branding: QUOTE_BRANDING,
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
      // Written in the SAME insert as the row, never stamped on afterwards: a
      // published urgent quote with no accept_by would look like a list quote
      // to the reissue check and to the pipeline worker. Omitted entirely for a
      // quote a person raises, which is every quote but the agent's.
      ...(ctx.agentQuote
        ? {
            pricing_mode: ctx.agentQuote.pricingMode,
            accept_by: ctx.agentQuote.acceptBy,
            reissue_of: ctx.agentQuote.reissueOf,
            urgency_note: ctx.agentQuote.urgencyNote,
          }
        : {}),
    })
    .select('id')
    .single()

  if (claimError || !claimed) {
    if (claimError?.code === '23505') {
      return {
        success: false,
        code: 'IN_FLIGHT',
        error: 'A quote is already being generated for this deal. Give it a moment, then use Retry quote.',
      }
    }
    console.error('deal_quotes claim failed', claimError?.message)
    return { success: false, error: 'Could not start the quote. Please try again.' }
  }

  return runFromRow(admin, (claimed as { id: string }).id, ctx, templateId, expiresOn, createInput)
}

const fail = failQuoteStep

export async function runFromRow(
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

  return publishAndReadBack(admin, dealQuoteId, quoteId, lineItemIds, ctx, expiresOn)
}
