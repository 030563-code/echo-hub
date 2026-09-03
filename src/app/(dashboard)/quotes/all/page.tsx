import { getDealsByStage } from '@/app/actions/hubspot/getDeals'
import { createServerClient } from '@/lib/supabase/server'
import AllQuotesClient from './all-quotes-client'
import { getOwnerIndex } from '@/app/actions/hubspot/getOwners'
import { ownerLabel, teamLabel } from '@/lib/hubspot-owners'
import { DealFilterBar } from '@/components/quotes/deal-filter-bar'
import { parseDealFilters } from '@/lib/deal-filters'
import { HUBSPOT_PIPELINES, stageLabel } from '@/lib/hubspot-constants'

/** Paging and scope, plus every deal-filter parameter, so the filters survive
 *  a page change. */
type SearchParams = Record<string, string | string[] | undefined>

interface DealRecord {
  id: string
}

export default async function AllQuotesPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>
}) {
  const params = await searchParams
  const page = Math.max(1, parseInt(typeof params.page === 'string' ? params.page : '1', 10) || 1)
  const cursorStack = typeof params.cursors === 'string' ? params.cursors : ''
  const cursors = cursorStack ? cursorStack.split(',').filter(Boolean) : []
  const after = cursors[cursors.length - 1] as string | undefined

  // All reps by default, matching the board and the stage queues, so the choice
  // carries between tabs. getDealsByStage puts a non-admin back to 'mine'.
  const scope = params.scope === 'mine' ? 'mine' : 'all'
  const dealFilters = parseDealFilters(params)
  const { data: deals, error, hasNextPage, nextAfter, isAdmin, notice } = await getDealsByStage(
    'all',
    page,
    after,
    scope,
    dealFilters,
  )

  // Owner and team names for the all-reps view. One call, memoised, and only
  // made when a column actually reads it.
  const owners = scope === 'all' && isAdmin ? await getOwnerIndex() : null

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

  const selectedPipeline = Object.values(HUBSPOT_PIPELINES).find((p) => p.id === dealFilters.pipelineId)
  const stageOptions = selectedPipeline
    ? Object.values(selectedPipeline.stages).map((stageId) => ({
        id: stageId,
        label: stageLabel(selectedPipeline.id, stageId),
      }))
    : []

  return (
    <AllQuotesClient
      initialDeals={deals || []}
      error={error}
      notice={notice}
      probabilityMap={probabilityMap}
      currentPage={page}
      hasNextPage={!!hasNextPage}
      cursorStack={cursorStack}
      nextAfter={nextAfter}
      isAdmin={!!isAdmin}
      scope={scope}
      carryParams={{
        ...Object.fromEntries(
          Object.entries(params).flatMap(([name, value]) => {
            if (name === 'page' || name === 'cursors') return []
            if (Array.isArray(value)) return value[0] === undefined ? [] : [[name, value[0]] as [string, string]]
            return value === undefined ? [] : [[name, value] as [string, string]]
          }),
        ),
      }}
      filterBar={
        <DealFilterBar
          action="/quotes/all"
          filters={dealFilters}
          hidden={scope === 'mine' ? { scope: 'mine' } : {}}
          pipelines={Object.values(HUBSPOT_PIPELINES).map((p) => ({ id: p.id, label: p.label }))}
          stages={stageOptions}
          ownerNameById={owners?.ownerNameById}
          showOwner={scope === 'all' && !!isAdmin}
        />
      }
      ownerByDeal={
        owners
          ? Object.fromEntries(
              (deals ?? []).map((d) => [
                d.id,
                {
                  owner: ownerLabel(owners, d.properties.hubspot_owner_id),
                  team: teamLabel(owners, d.properties.hubspot_team_id, d.properties.hubspot_owner_id),
                },
              ]),
            )
          : {}
      }
    />
  )
}
