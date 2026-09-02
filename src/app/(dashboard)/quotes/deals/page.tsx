import { getQuoteRequests } from '@/app/actions/hubspot/getQuoteRequests'
import { Plus, AlertCircle, FileText } from 'lucide-react'
import { Card } from '@/components/ui/card'
import Link from 'next/link'
import { PaginationNav } from '@/components/ui/pagination-nav'
import { DealList } from '@/components/quotes/deal-list'
import { formatMoney } from '@/lib/utils'

interface SearchParams {
  page?: string
  cursors?: string
}

export default async function QuoteRequestsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>
}) {
  const params = await searchParams
  const page = Math.max(1, parseInt(params.page ?? '1', 10) || 1)
  const cursorStack = params.cursors ?? ''
  const cursors = cursorStack ? cursorStack.split(',').filter(Boolean) : []
  // The after-cursor for the current page is the last item in the cursor stack
  const after = cursors[cursors.length - 1] as string | undefined

  const { success, data: deals, error, hasNextPage, nextAfter } = await getQuoteRequests(page, after)

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Incoming Deals</h1>
          <p className="text-gray-500 text-sm mt-1">Manage and process new deals from HubSpot.</p>
        </div>
        <Link
          href="/quotes/create/manual"
          className="w-full sm:w-auto inline-flex items-center justify-center font-bold uppercase tracking-wider transition-all focus:outline-none focus:ring-2 border-2 rounded-none bg-echo-yellow text-black border-echo-yellow hover:bg-yellow-400 hover:border-yellow-400 focus:ring-yellow-500/50 px-6 py-3 text-sm font-medium"
        >
          <Plus className="w-4 h-4 mr-2" />
          Create Deal
        </Link>
      </div>

      {!success ? (
        <Card className="p-6 border-red-200 bg-red-50">
          <div className="flex items-center gap-3 text-red-800">
            <AlertCircle className="w-5 h-5" />
            <p className="font-medium">Error loading deals</p>
          </div>
          <p className="text-red-600 text-sm mt-1 ml-8">{error}</p>
        </Card>
      ) : deals && deals.length > 0 ? (
        <>
          <DealList
            dateHeader="Created Date"
            badgeHeader="Status"
            actionStyle="yellowOutline"
            rows={deals.map((deal) => ({
              id: deal.id,
              name: deal.properties.dealname,
              dateValue: new Date(deal.properties.createdate).toLocaleDateString('en-US', {
                year: 'numeric',
                month: 'short',
                day: 'numeric',
                hour: '2-digit',
                minute: '2-digit'
              }),
              amountFormatted: deal.properties.amount
                ? formatMoney(Number(deal.properties.amount), deal.properties.deal_currency_code ?? 'USD')
                : '-',
              badge: { text: 'Quote Request', className: 'bg-yellow-100 text-yellow-800 border-yellow-200' },
              action: { href: `/quotes/deals/${deal.id}`, label: 'View Details' },
            }))}
          />
          <PaginationNav
            currentPage={page}
            hasNextPage={!!hasNextPage}
            basePath="/quotes/deals"
            cursorStack={cursorStack}
            nextAfter={nextAfter}
          />
        </>
      ) : (
        <div className="text-center py-12 bg-white border border-gray-200 rounded-lg border-dashed">
          <div className="mx-auto h-12 w-12 text-gray-300 mb-3">
            <FileText className="w-full h-full" />
          </div>
          <h3 className="text-lg font-medium text-gray-900">No deals found</h3>
          <p className="text-gray-500 text-sm mt-1 max-w-sm mx-auto">
            There are no deals assigned to your HubSpot account at this time.
          </p>
        </div>
      )}
    </div>
  )
}
