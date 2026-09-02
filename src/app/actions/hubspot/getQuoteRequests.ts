'use server'

import { getDealsByStage } from './getDeals'
import type { HubSpotDeal } from '@/lib/hubspot-types'


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
