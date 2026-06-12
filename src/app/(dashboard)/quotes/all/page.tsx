import { getDealsByStage } from '@/app/actions/hubspot/getDeals'
import { createServerClient } from '@/lib/supabase/server'
import AllQuotesClient from './all-quotes-client'

interface SearchParams {
  page?: string
  cursors?: string
}

interface DealRecord {
  id: string
}

export default async function AllQuotesPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>
}) {
  const params = await searchParams
  const page = Math.max(1, parseInt(params.page ?? '1', 10) || 1)
  const cursorStack = params.cursors ?? ''
  const cursors = cursorStack ? cursorStack.split(',').filter(Boolean) : []
  const after = cursors[cursors.length - 1] as string | undefined

  const { data: deals, error, hasNextPage, nextAfter } = await getDealsByStage('all', page, after)

  // Fetch deal_probability from registry for all deal IDs
  const probabilityMap: Record<string, number | null> = {}
  if (deals && deals.length > 0) {
    const supabase = await createServerClient()
    const dealIds = deals.map((d: DealRecord) => d.id)
    const { data: registry } = await supabase
      .from('deals_registry')
      .select('hubspot_deal_id, deal_probability')
      .in('hubspot_deal_id', dealIds)

    if (registry) {
      for (const row of registry) {
        probabilityMap[row.hubspot_deal_id] = row.deal_probability
      }
    }
  }

  return (
    <AllQuotesClient
      initialDeals={deals || []}
      error={error}
      probabilityMap={probabilityMap}
      currentPage={page}
      hasNextPage={!!hasNextPage}
      cursorStack={cursorStack}
      nextAfter={nextAfter}
    />
  )
}
