import { getDealsByStage } from '@/app/actions/hubspot/getDeals'
import { Card } from '@/components/ui/card'
import { AlertCircle, Send } from 'lucide-react'
import { PaginationNav } from '@/components/ui/pagination-nav'
import { DealList } from '@/components/quotes/deal-list'

interface SearchParams {
  page?: string
  cursors?: string
}

export default async function SentQuotesPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>
}) {
  const params = await searchParams
  const page = Math.max(1, parseInt(params.page ?? '1', 10) || 1)
  const cursorStack = params.cursors ?? ''
  const cursors = cursorStack ? cursorStack.split(',').filter(Boolean) : []
  const after = cursors[cursors.length - 1] as string | undefined

  const { success, data: deals, error, hasNextPage, nextAfter } = await getDealsByStage('quotation_sent', page, after)

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Sent Quotes</h1>
          <p className="text-gray-500 text-sm mt-1">Quotes that have been sent to customers.</p>
        </div>
      </div>

      {!success ? (
        <Card className="p-6 border-red-200 bg-red-50">
          <div className="flex items-center gap-3 text-red-800">
            <AlertCircle className="w-5 h-5" />
            <p className="font-medium">Error loading sent quotes</p>
          </div>
          <p className="text-red-600 text-sm mt-1 ml-8">{error}</p>
        </Card>
      ) : deals && deals.length > 0 ? (
        <>
          <DealList
            dateHeader="Created Date"
            badgeHeader="Status"
            rows={deals.map((deal) => ({
              id: deal.id,
              name: deal.properties.dealname,
              dateValue: new Date(deal.properties.createdate).toLocaleDateString('en-US', {
                year: 'numeric',
                month: 'short',
                day: 'numeric'
              }),
              amountFormatted: deal.properties.amount
                ? new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(Number(deal.properties.amount))
                : '-',
              badge: { text: 'Sent', className: 'bg-blue-100 text-blue-800 border-blue-200' },
              action: { href: `/quotes/deals/${deal.id}`, label: 'View Details' },
            }))}
          />
          <PaginationNav
            currentPage={page}
            hasNextPage={!!hasNextPage}
            basePath="/quotes/sent"
            cursorStack={cursorStack}
            nextAfter={nextAfter}
          />
        </>
      ) : (
        <div className="text-center py-12 bg-white border border-gray-200 rounded-lg border-dashed">
          <div className="mx-auto h-12 w-12 text-gray-300 mb-3">
            <Send className="w-full h-full" />
          </div>
          <h3 className="text-lg font-medium text-gray-900">No sent quotes found</h3>
          <p className="text-gray-500 text-sm mt-1 max-w-sm mx-auto">
            You haven&apos;t sent any quotes yet.
          </p>
        </div>
      )}
    </div>
  )
}
