'use client'

import { Card } from '@/components/ui/card'
import { AlertCircle, Filter } from 'lucide-react'
import { HUBSPOT_PIPELINES } from '@/lib/hubspot-constants'
import { PaginationNav } from '@/components/ui/pagination-nav'
import { DealList } from '@/components/quotes/deal-list'
import type { HubSpotDeal } from '@/lib/hubspot-types'
import { formatMoney } from '@/lib/utils'
import { stageChip } from '@/lib/stage-chip'
import Link from 'next/link'


interface AllQuotesClientProps {
  initialDeals: HubSpotDeal[]
  error?: string
  probabilityMap: Record<string, number | null>
  currentPage: number
  hasNextPage: boolean
  cursorStack: string
  nextAfter?: string
  /** Whether the caller may switch to every rep's deals. */
  isAdmin: boolean
  scope: 'mine' | 'all'
  /** Owner and team per deal, only populated in the all-reps view. */
  ownerByDeal: Record<string, { owner: string; team: string }>
  /** The shared filter bar, rendered on the server. Filtering is server-side
   *  now, so this component no longer narrows anything itself. */
  filterBar?: React.ReactNode
}

export default function AllQuotesClient({ initialDeals, error, probabilityMap, currentPage, hasNextPage, cursorStack, nextAfter, isAdmin, scope, ownerByDeal, filterBar }: AllQuotesClientProps) {
  // The rows arrive already narrowed. The pipeline and stage selects that used
  // to live here filtered only the 25 rows on the current page, and said so in
  // its own counter ("of N deals on this page"), which meant a rep searching
  // for a real deal on page 4 was told it did not exist. The shared filter bar
  // pushes the same choices into the HubSpot search instead.
  const deals = initialDeals

  // Flatten pipelines for easier lookup
  const pipelines = Object.values(HUBSPOT_PIPELINES)

  // Helper to get pipeline label
  const getPipelineLabel = (pipelineId: string) => {
    const pipeline = pipelines.find(p => p.id === pipelineId)
    return pipeline ? pipeline.label : pipelineId
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">All Quotes</h1>
          <p className="text-gray-500 text-sm mt-1">View and filter all your deals across pipelines.</p>
        </div>
      </div>

      {/* Filters */}
      <Card className="p-4 bg-white border-gray-200">
        {isAdmin && (
          <div className="mb-4 flex items-center gap-2 border-b border-gray-100 pb-4">
            <span className="text-xs font-bold uppercase text-gray-500">Showing</span>
            {/* Plain links, not client state: the scope decides what the SERVER
                fetches, so it belongs in the URL where it survives paging. */}
            <Link
              href="/quotes/all"
              className={
                scope === 'mine'
                  ? 'rounded border border-echo-yellow bg-yellow-50 px-2.5 py-1 text-xs font-semibold text-gray-900'
                  : 'rounded border border-gray-200 px-2.5 py-1 text-xs text-gray-600 hover:border-gray-300'
              }
            >
              My deals
            </Link>
            <Link
              href="/quotes/all?scope=all"
              className={
                scope === 'all'
                  ? 'rounded border border-echo-yellow bg-yellow-50 px-2.5 py-1 text-xs font-semibold text-gray-900'
                  : 'rounded border border-gray-200 px-2.5 py-1 text-xs text-gray-600 hover:border-gray-300'
              }
            >
              All reps
            </Link>
          </div>
        )}
        {filterBar}
        <div className="mt-3 text-sm text-gray-500">Showing {deals.length} deals on this page</div>
      </Card>

      {error ? (
        <Card className="p-6 border-red-200 bg-red-50">
          <div className="flex items-center gap-3 text-red-800">
            <AlertCircle className="w-5 h-5" />
            <p className="font-medium">Error loading quotes</p>
          </div>
          <p className="text-red-600 text-sm mt-1 ml-8">{error}</p>
        </Card>
      ) : deals.length > 0 ? (
        <DealList
          dateHeader="Created Date"
          badgeHeader="Stage"
          pipelineHeader="Pipeline"
          probabilityHeader="Probability"
          rows={deals.map((deal) => ({
            id: deal.id,
            name: deal.properties.dealname,
            pipelineLabel: getPipelineLabel(deal.properties.pipeline),
            dateValue: new Date(deal.properties.createdate).toLocaleDateString('en-US', {
              year: 'numeric',
              month: 'short',
              day: 'numeric'
            }),
            amountFormatted: deal.properties.amount
              ? formatMoney(Number(deal.properties.amount), deal.properties.deal_currency_code ?? 'USD')
              : '-',
            // The real stage in its family colour, like every other list.
            badge: stageChip(deal.properties.pipeline, deal.properties.dealstage),
            ownerLabel:
              scope === 'all' && ownerByDeal[deal.id]
                ? `${ownerByDeal[deal.id].owner} - ${ownerByDeal[deal.id].team}`
                : undefined,
            probabilityLabel: probabilityMap[deal.id] != null ? `${probabilityMap[deal.id]}%` : '\u2014',
            action: { href: `/quotes/deals/${deal.id}`, label: 'View Details' },
          }))}
        />
      ) : (
        <div className="text-center py-12 bg-white border border-gray-200 rounded-lg border-dashed">
          <div className="mx-auto h-12 w-12 text-gray-300 mb-3">
            <Filter className="w-full h-full" />
          </div>
          <h3 className="text-lg font-medium text-gray-900">No quotes found</h3>
          <p className="text-gray-500 text-sm mt-1 max-w-sm mx-auto">
            Try adjusting your filters or check back later.
          </p>
        </div>
      )}

      {/* The pipeline/stage filter only operates on the currently loaded page, while
          paging is cursor-based on the full server-side set. Showing pagination during a
          filter would let a user "page" filtered-only views and produce misleading results,
          so we hide it while a filter is active and keep the count label honest above. */}
      {deals.length > 0 && (
        <PaginationNav
          currentPage={currentPage}
          hasNextPage={hasNextPage}
          basePath="/quotes/all"
          cursorStack={cursorStack}
          nextAfter={nextAfter}
        />
      )}
    </div>
  )
}
