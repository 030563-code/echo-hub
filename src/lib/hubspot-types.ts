/**
 * Shared HubSpot deal shape for the list surfaces.
 *
 * This interface was declared byte-identically in three places (getDeals,
 * getQuoteRequests and the all-quotes client), so adding a property meant
 * finding all three. Adding deal_currency_code was the change that made that
 * worth fixing.
 */
export interface HubSpotDeal {
  id: string
  properties: {
    dealname: string
    amount: string | null
    createdate: string
    dealstage: string
    pipeline: string
    /** ISO code. Optional because HubSpot omits the property on deals that
     *  have never had one set. */
    deal_currency_code?: string | null
  }
}

/** The property list every deal-list fetch requests, so the lists cannot drift
 *  apart on what they can display. */
export const DEAL_LIST_PROPERTIES = [
  'dealname',
  'amount',
  'createdate',
  'dealstage',
  'pipeline',
  'deal_currency_code',
] as const
