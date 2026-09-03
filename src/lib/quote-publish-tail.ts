import 'server-only'

import type { createAdminClient } from '@/lib/supabase/admin'
import { hubspotFetch } from '@/lib/hubspot-client'
import {
  QUOTE_ASSOCIATION_TYPE_IDS,
  QUOTE_PUBLISHED_STATUS,
  QUOTE_READBACK_PROPERTIES,
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
  // and it is not always there on the first GET.
  let props: Record<string, string | null> = {}
  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await hubspotFetch(
      `${HS}/crm/v3/objects/quotes/${quoteId}?properties=${QUOTE_READBACK_PROPERTIES.join(',')}`,
    )
    if (!response.ok) {
      return failQuoteStep(admin, dealQuoteId, 'read_back', await readError(response, 'read_back'), failStatus)
    }
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
