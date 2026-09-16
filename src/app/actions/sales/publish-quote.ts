'use server'

import { createAdminClient } from '@/lib/supabase/admin'
import { assertDealAccess } from '@/lib/authz'
import { hubspotFetch } from '@/lib/hubspot-client'
import { quoteTemplateIdFor } from '@/lib/pipeline-config'
import { quoteExpiryDate } from '@/lib/hubspot-quote'
import type { PricedCartLine } from '@/lib/quote-pricing'
import { runFromRow, type PublishQuoteContext, type PublishQuoteResult } from '@/lib/quote-publish-tail'

// Re-exported so existing importers keep their one import site. The runtime
// helpers deliberately do NOT come back out of this module: exported from a
// 'use server' file they would each become a callable server action.
export type {
  AgentQuoteStamp,
  PublishFailureCode,
  PublishQuoteContext,
  PublishQuoteResult,
  PublishedQuote,
  QuoteStep,
} from '@/lib/quote-publish-tail'

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
