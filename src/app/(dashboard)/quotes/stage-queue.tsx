import Link from 'next/link'
import { Card } from '@/components/ui/card'
import { AlertCircle } from 'lucide-react'
import { PaginationNav } from '@/components/ui/pagination-nav'
import { DealList } from '@/components/quotes/deal-list'
import { DealFilterBar } from '@/components/quotes/deal-filter-bar'
import { getDealsByStage } from '@/app/actions/hubspot/getDeals'
import { getOwnerIndex } from '@/app/actions/hubspot/getOwners'
import { parseStageQueueDealFilters } from '@/lib/deal-filters'
import { HUBSPOT_PIPELINES } from '@/lib/hubspot-constants'
import { formatMoney } from '@/lib/utils'
import { stageChip } from '@/lib/stage-chip'

/**
 * One stage-scoped queue: Deals, Sent, Accepted or Won.
 *
 * Those four pages were byte-for-byte identical apart from a category, a title,
 * an icon and an empty-state sentence, and none of them carried the scope or
 * the filters. Dean: "the USA sales and All reps filter doesn't carry over to
 * the Deals and there's also no way for me to filter in the other tabs which
 * should run the same filter". So they share this instead of each growing its
 * own copy of the same wiring.
 *
 * The stage filter is deliberately absent here. Each category already pins
 * `dealstage IN <family>`, so offering a second stage control would let a rep
 * build a query that can only ever return nothing. parseStageQueueDealFilters
 * strips it, and the bar renders no stage select because no stages are passed.
 */

export interface StageQueueProps {
  category: 'quote_requests' | 'quotation_sent' | 'accepted' | 'won'
  basePath: string
  title: string
  description: string
  /** Rendered in the empty state. */
  emptyIcon: React.ReactNode
  emptyTitle: string
  emptyBody: string
  errorTitle: string
  /** Optional button beside the heading, e.g. "Create Deal". */
  headerAction?: React.ReactNode
  /** The Deals queue shows a time alongside the date; the rest do not. */
  showTime?: boolean
  actionStyle?: 'yellowOutline'
  searchParams: Record<string, string | string[] | undefined>
}

const chipActive =
  'rounded border border-echo-yellow bg-yellow-50 px-2.5 py-1 text-xs font-semibold text-gray-900'
const chipIdle =
  'rounded border border-gray-200 px-2.5 py-1 text-xs text-gray-600 hover:border-gray-300'

export async function StageQueue({
  category,
  basePath,
  title,
  description,
  emptyIcon,
  emptyTitle,
  emptyBody,
  errorTitle,
  headerAction,
  showTime = false,
  actionStyle,
  searchParams,
}: StageQueueProps) {
  const params = searchParams
  const page = Math.max(1, parseInt(typeof params.page === 'string' ? params.page : '1', 10) || 1)
  const cursorStack = typeof params.cursors === 'string' ? params.cursors : ''
  const cursors = cursorStack ? cursorStack.split(',').filter(Boolean) : []
  const after = cursors[cursors.length - 1] as string | undefined

  // Defaults to All reps, matching the board, so the choice carries between
  // tabs even before anyone touches the toggle. A default that lives only in
  // the page and not in the URL cannot be carried by the nav, which is how the
  // board's All reps silently became My deals on arriving at Deals.
  // getDealsByStage puts a non-admin back to their own deals regardless.
  const scope = params.scope === 'mine' ? 'mine' : 'all'
  const dealFilters = parseStageQueueDealFilters(params)

  const { success, data: deals, error, hasNextPage, nextAfter, isAdmin } = await getDealsByStage(
    category,
    page,
    after,
    scope,
    dealFilters,
  )

  // Only the all-reps view reads owner names, so the extra call is only made
  // when something shows them.
  const owners = scope === 'all' && isAdmin ? await getOwnerIndex() : null

  // Everything except paging survives a scope switch: dropping the filters here
  // would look like the filter had been ignored.
  const carried = new URLSearchParams(
    Object.entries(params).flatMap(([name, value]) => {
      if (name === 'page' || name === 'cursors' || name === 'scope') return []
      if (Array.isArray(value)) return value.map((v) => [name, v] as [string, string])
      return value === undefined ? [] : [[name, value] as [string, string]]
    }),
  )
  const scopeHref = (next: 'mine' | 'all') => {
    const q = new URLSearchParams(carried)
    // 'all' is the default, so only 'mine' needs saying. Writing both would put
    // a redundant parameter on every link.
    if (next === 'mine') q.set('scope', 'mine')
    const query = q.toString()
    return query ? `${basePath}?${query}` : basePath
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">{title}</h1>
          <p className="text-gray-500 text-sm mt-1">{description}</p>
        </div>
        {headerAction}
      </div>

      <Card className="p-4 bg-white border-gray-200">
        {isAdmin && (
          <div className="mb-3 flex items-center gap-2 border-b border-gray-100 pb-3">
            <span className="text-xs font-bold uppercase text-gray-500">Showing</span>
            <Link href={scopeHref('mine')} className={scope === 'mine' ? chipActive : chipIdle}>
              My deals
            </Link>
            <Link href={scopeHref('all')} className={scope === 'all' ? chipActive : chipIdle}>
              All reps
            </Link>
          </div>
        )}
        <DealFilterBar
          action={basePath}
          filters={dealFilters}
          hidden={scope === 'mine' ? { scope: 'mine' } : {}}
          pipelines={Object.values(HUBSPOT_PIPELINES).map((p) => ({ id: p.id, label: p.label }))}
          ownerNameById={owners?.ownerNameById}
          showOwner={scope === 'all' && !!isAdmin}
        />
      </Card>

      {!success ? (
        <Card className="p-6 border-red-200 bg-red-50">
          <div className="flex items-center gap-3 text-red-800">
            <AlertCircle className="w-5 h-5" />
            <p className="font-medium">{errorTitle}</p>
          </div>
          <p className="text-red-600 text-sm mt-1 ml-8">{error}</p>
        </Card>
      ) : deals && deals.length > 0 ? (
        <>
          <DealList
            dateHeader="Created Date"
            badgeHeader="Status"
            {...(actionStyle ? { actionStyle } : {})}
            rows={deals.map((deal) => ({
              id: deal.id,
              name: deal.properties.dealname,
              dateValue: new Date(deal.properties.createdate).toLocaleDateString('en-US', {
                year: 'numeric',
                month: 'short',
                day: 'numeric',
                ...(showTime ? { hour: '2-digit' as const, minute: '2-digit' as const } : {}),
              }),
              amountFormatted: deal.properties.amount
                ? formatMoney(Number(deal.properties.amount), deal.properties.deal_currency_code ?? 'USD')
                : '-',
              badge: stageChip(deal.properties.pipeline, deal.properties.dealstage),
              action: { href: `/quotes/deals/${deal.id}`, label: 'View Details' },
            }))}
          />
          <PaginationNav
            currentPage={page}
            hasNextPage={!!hasNextPage}
            basePath={basePath}
            cursorStack={cursorStack}
            nextAfter={nextAfter}
            carryParams={{
              ...Object.fromEntries(carried),
              ...(scope === 'mine' ? { scope: 'mine' } : {}),
            }}
          />
        </>
      ) : (
        <div className="text-center py-12 bg-white border border-gray-200 rounded-lg border-dashed">
          <div className="mx-auto h-12 w-12 text-gray-300 mb-3">{emptyIcon}</div>
          <h3 className="text-lg font-medium text-gray-900">{emptyTitle}</h3>
          <p className="text-gray-500 text-sm mt-1 max-w-sm mx-auto">{emptyBody}</p>
        </div>
      )}
    </div>
  )
}
