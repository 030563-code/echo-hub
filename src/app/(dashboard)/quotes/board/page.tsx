import { Suspense } from 'react'
import Link from 'next/link'
import { AlertCircle } from 'lucide-react'
import { requireCapability } from '@/lib/authz'
import { TableSkeleton } from '@/components/ui/table-skeleton'
import { getDealsForBoard, type BoardScope } from '@/app/actions/hubspot/getDealsForBoard'
import { DealsBoard } from '@/components/quotes/deals-board'
import { HubQuotedBadge } from '@/components/quotes/hub-quoted-badge'
import { CreateDealButton } from '@/components/quotes/create-deal-button'
import { Card } from '@/components/ui/card'
import { FilterNotice } from '@/components/quotes/filter-notice'
import { DealFilterBar } from '@/components/quotes/deal-filter-bar'
import { dealFiltersToQuery, parseBoardDealFilters } from '@/lib/deal-filters'
import { withStoredQuotesFilters } from '@/lib/page-state-server'

export const dynamic = 'force-dynamic'

/**
 * The deals board. Dean's words: "Hubspot has the very nice kanban style view
 * of the deals which similar to the Purchase order style which we should
 * replicate. Dave should have access to also view all the deals in Hubspot
 * where it also shows the hubspot team pipeline associated with it."
 *
 * Replaces the Pending tab, which painted every row one grey badge reading
 * "Pending" whatever stage the deal was actually at.
 *
 * Scope lives in the URL so a view is linkable, and is re-decided
 * server-side: a rep who edits it gets their own deals back. The pipeline is
 * the active organisation's (the sidebar switch), never a parameter here.
 *
 * STREAMED since 16 Sep 2026. HubSpot is in the US and the server is in
 * London, so the deals search is the slowest thing on any Hub page. The
 * heading, the scope and window chips go out at once; the board itself
 * arrives inside a Suspense boundary when HubSpot answers. Nothing is
 * cached and nothing is stale, the page simply stops waiting to start.
 */
export default async function DealsBoardPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const auth = await requireCapability(['quotes.view', 'quotes.create'])
  // A bare url means the sidebar, so read with the filters this rep last
  // chose. Anything explicit (a link, a bookmark, Clear) is obeyed as written.
  const params = await withStoredQuotesFilters(await searchParams)

  const windowDays = Number(params.window) || 60

  // The board pins the active organisation's pipeline itself, so a `pipeline`
  // filter never reaches the markup. parseBoardDealFilters is what guarantees
  // that; its own doc comment explains what breaks otherwise.
  const dealFilters = parseBoardDealFilters(params)

  // Dean asked the board to open on All reps rather than on the viewer's own
  // deals. The same rule getDealsForBoard applies, applied here too so the
  // chips can render before HubSpot has answered: a non-admin asking for 'all'
  // is put back to 'mine'.
  const isAdmin = auth.profile.is_super_admin === true || auth.capabilities.has('admin')
  const scopeParam = typeof params.scope === 'string' ? params.scope : ''
  const scope: BoardScope = isAdmin && scopeParam !== 'mine' ? 'all' : 'mine'

  const link = (next: Record<string, string>) => {
    const q = new URLSearchParams({
      scope,
      window: String(windowDays),
      // Switching scope or window must not silently drop the filters, which
      // would look like the filter had been ignored.
      ...dealFiltersToQuery(dealFilters),
      ...next,
    })
    return `/quotes/board?${q.toString()}`
  }

  const chip = (active: boolean) =>
    active
      ? 'rounded border border-echo-yellow bg-yellow-50 px-2.5 py-1 text-xs font-semibold text-gray-900'
      : 'rounded border border-gray-200 px-2.5 py-1 text-xs text-gray-600 hover:border-gray-300'

  return (
    <div className="space-y-4">
      {/* Title left, Create Deal right: the same place the Deals tab puts it. */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Board</h1>
          <p className="text-sm text-gray-600">
            Deals by their real HubSpot stage. Drag a card, or use Move on it, to change stage.
          </p>
          <p className="mt-1 flex items-center gap-1.5 text-xs text-gray-500">
            <HubQuotedBadge decorative />
            marks a deal quoted in the Hub.
          </p>
        </div>
        {auth.capabilities.has('quotes.create') && <CreateDealButton />}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {isAdmin && (
          <div className="flex items-center gap-1">
            <Link href={link({ scope: 'mine' })} className={chip(scope === 'mine')}>My deals</Link>
            <Link href={link({ scope: 'all' })} className={chip(scope === 'all')}>All reps</Link>
          </div>
        )}
        <div className="flex items-center gap-1">
          {[30, 60, 120, 365].map((days) => (
            <Link key={days} href={link({ window: String(days) })} className={chip(windowDays === days)}>
              {days === 365 ? '1 year' : `${days}d`}
            </Link>
          ))}
        </div>
      </div>

      <Suspense fallback={<TableSkeleton columns={5} rows={6} headings={['Stage', 'Deal', 'Company', 'Amount', 'Owner']} />}>
        <BoardSection scope={scope} windowDays={windowDays} dealFilters={dealFilters} />
      </Suspense>
    </div>
  )
}

/**
 * The half of the page that waits on HubSpot. Everything above it has already
 * been sent by the time this resolves.
 */
async function BoardSection({
  scope,
  windowDays,
  dealFilters,
}: {
  scope: BoardScope
  windowDays: number
  dealFilters: ReturnType<typeof parseBoardDealFilters>
}) {
  const result = await getDealsForBoard({ scope, windowDays, dealFilters })

  if (!result.success || !result.groups) {
    return (
      <Card className="bg-white border-gray-200">
        <p className="text-sm text-red-700">{result.error}</p>
      </Card>
    )
  }
  // The action re-decides the scope; trust its answer over the URL for what
  // the filter bar shows.
  const shown: BoardScope = result.scope ?? scope

  return (
    <>
      <DealFilterBar
        action="/quotes/board"
        filters={dealFilters}
        hidden={{
          scope: shown,
          window: String(windowDays),
        }}
        stages={result.groups
          .map((g) => g.column)
          .filter((c) => c.stageId !== '')
          .map((c) => ({ id: c.stageId, label: c.label }))}
        ownerNameById={result.owners?.ownerNameById}
        showOwner={shown === 'all'}
      />

      <FilterNotice notice={result.notice} />

      {result.filterError && (
        <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <p>{result.filterError}</p>
        </div>
      )}

      {!result.hubQuotedIds && (
        <p className="text-xs text-amber-800">
          The Hub could not check which of these deals it quoted, so no EH marks are shown. Reload to try again.
        </p>
      )}

      <DealsBoard
        groups={result.groups}
        owners={result.owners}
        showOwner={shown === 'all'}
        hubQuotedIds={result.hubQuotedIds}
      />

      {result.truncated && (
        <p className="text-xs text-gray-500">
          Showing the most recently updated deals only. Widen the window, or use the All tab for the
          full list.
        </p>
      )}
    </>
  )
}
