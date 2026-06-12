'use server'

import { getDealsByStage } from './getDeals'

interface HubSpotDeal {
  id: string
  properties: {
    dealname: string
    amount: string | null
    createdate: string
    dealstage: string
    pipeline: string
  }
}

interface QuoteRequestResult {
  success: boolean
  data?: HubSpotDeal[]
  error?: string
  hasNextPage?: boolean
  nextAfter?: string
}

export async function getQuoteRequests(page: number = 1, after?: string): Promise<QuoteRequestResult> {
  return getDealsByStage('quote_requests', page, after)
}
