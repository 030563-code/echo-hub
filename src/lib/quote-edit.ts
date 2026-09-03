import { QUOTATION_ACCEPTED_STAGES } from '@/lib/hubspot-constants'
import { US_ACCEPTED_DEAL_STATUS } from '@/lib/customer-invoice/constants'
import { isClosedStage } from '@/lib/deals-board'
import type { DiscountMode } from '@/lib/pricing'
import type { PricedCartLine } from '@/lib/quote-pricing'

/**
 * The guards around recalling a published HubSpot quote, as pure predicates.
 *
 * Separated from the action so they can be tested without a HubSpot or Supabase
 * double. The accepted-deal guard in particular is load bearing and must not be
 * quietly weakened; see recallBlockReason.
 */

export interface RecallGuardInput {
  /** deal_quotes.status. */
  rowStatus: string | null | undefined
  /** deal_quotes.hubspot_quote_id. */
  hubspotQuoteId: string | null | undefined
  /** The deal's LIVE HubSpot dealstage. */
  dealStage: string | null | undefined
  /** deals_registry.deal_status, which n8n syncs to the stage id. */
  registryDealStatus: string | null | undefined
}

/**
 * Whether this deal counts as accepted, and so must not have its registry row
 * rewritten.
 *
 * The reason is specific and verified. Republishing an edited quote re-syncs
 * the deal's line items and deals_registry, and `notify_quote_accepted()` on
 * that table fires the Xero AND MCS webhooks on any change to `line_items_raw`
 * once `deal_status` is the Quotation Accepted stage id. So an edit on an
 * accepted deal would raise a SECOND draft Xero quote and a second MCS contract
 * behind the rep's back. Refusing is also the right business answer: once a
 * customer has accepted, the agreed document does not get rewritten underneath
 * them.
 *
 * Checked against BOTH the live HubSpot stage and the registry's own
 * deal_status, because they can disagree. They are deliberately asymmetric: the
 * stage arm matches every pipeline's accepted stage, while the registry arm
 * matches ONLY US_ACCEPTED_DEAL_STATUS, because that single literal is what
 * notify_quote_accepted() itself keys on. Do not "fix" that asymmetry.
 *
 * Either arm saying "accepted" is enough to stop. Callers must also treat "could
 * not read the state" as accepted; see readAcceptance in edit-quote.ts.
 */
export function isDealAccepted(
  dealStage: string | null | undefined,
  registryDealStatus: string | null | undefined,
): boolean {
  const stage = String(dealStage ?? '').trim()
  const registryStatus = String(registryDealStatus ?? '').trim()
  return QUOTATION_ACCEPTED_STAGES.includes(stage) || registryStatus === US_ACCEPTED_DEAL_STATUS
}

/** Said at recall time, when the whole edit can still be refused outright. */
export const ACCEPTED_RECALL_MESSAGE =
  'This deal has already been accepted, and the Xero and MCS documents have been raised from it. Editing the quote now would raise them a second time, so it has to be changed in HubSpot and Xero directly.'

/**
 * Said at republish time, when the deal was accepted DURING the edit.
 *
 * By then the quote is already back in HubSpot as a draft with its link
 * offline, so refusing outright would strand the customer's url. The quote is
 * republished and only the registry write is skipped, which is the half that
 * would re-fire the Xero and MCS webhooks.
 */
export const ACCEPTED_MID_EDIT_MESSAGE =
  'This deal was accepted while the quote was being edited. The quote has been republished on its original link, but the deal and the Hub database were deliberately left alone, because rewriting them now would raise a second Xero quote and a second MCS contract. Reconcile the deal by hand.'

export function recallBlockReason(input: RecallGuardInput): string | null {
  if (input.rowStatus === 'editing') {
    return 'This quote is already recalled and open for editing. Finish it and republish, or republish it as it stands.'
  }
  if (input.rowStatus !== 'published') {
    return 'Only a published quote can be recalled. This one never finished publishing, so use Retry quote instead.'
  }
  if (!String(input.hubspotQuoteId ?? '').trim()) {
    return 'This quote has no HubSpot id recorded, so there is nothing to recall.'
  }

  const stage = String(input.dealStage ?? '').trim()

  if (isDealAccepted(stage, input.registryDealStatus)) {
    return ACCEPTED_RECALL_MESSAGE
  }

  if (isClosedStage(stage)) {
    return 'This deal is closed, so its quote can no longer be edited.'
  }

  return null
}

/** Why an edited quote cannot be republished, or null when it can be. */
export function republishBlockReason(rowStatus: string | null | undefined): string | null {
  if (rowStatus === 'editing') return null
  if (rowStatus === 'published') {
    return 'This quote is already published. Recall it first if you want to change it.'
  }
  return 'This quote is not open for editing. Recall the published quote first.'
}

/** The quote builder's cart line shape. */
export interface EditableCartLine {
  productId: string
  name: string
  sku?: string
  description?: string
  quantity: number
  unitPrice: number
  total: number
  discountMode?: DiscountMode
  discountValue?: number
}

/**
 * Turn the stored quote snapshot back into cart lines the builder can edit.
 *
 * The builder normally seeds itself from the DEAL's HubSpot line items, and
 * mapInitialLineItems drops the discount fields when it does. That is survivable
 * for a fresh quote, where the rep is entering the discount anyway, but not for
 * an edit: recalling a discounted quote and republishing it would silently
 * re-quote at full price. So an edit seeds from deal_quotes.line_items instead,
 * which is the exact priced cart that was published.
 *
 * The rep's original entry is not stored, only its result, so the mode is
 * recovered from which HubSpot field the price carries. That mapping is exactly
 * the one priceLine produces: a percentage discount sets hs_discount_percentage
 * and leaves the base in `price`, and a cash discount sets `discount` per unit.
 */
export function snapshotToCartLines(lines: readonly PricedCartLine[]): EditableCartLine[] {
  return lines.map((line) => {
    const percentage = line.priced.hubspot.hs_discount_percentage
    const perUnit = line.priced.hubspot.discount

    let discountMode: DiscountMode | undefined
    let discountValue: number | undefined
    if (percentage != null && percentage > 0) {
      discountMode = 'percent'
      discountValue = percentage
    } else if (perUnit != null && perUnit > 0) {
      discountMode = 'amount'
      discountValue = perUnit
    }

    return {
      productId: line.productId,
      name: line.name,
      sku: line.sku,
      description: line.description,
      quantity: line.quantity,
      // The pre-discount base, which is what the builder's price column holds
      // and what the server re-prices against.
      unitPrice: line.priced.hubspot.price,
      total: line.lineTotal,
      ...(discountMode ? { discountMode, discountValue } : {}),
    }
  })
}
