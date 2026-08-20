import { Skeleton } from '@/components/ui/skeleton'
import { TableSkeleton } from '@/components/ui/table-skeleton'

// Shared across all six quotes list tabs (requests/pending/sent/accepted/won/all) —
// the layout's <QuotesNav> stays rendered while this covers the fetch below it.
export default function QuotesLoading() {
  return (
    <div className="space-y-6">
      <div>
        <Skeleton className="h-7 w-48" />
        <Skeleton className="h-4 w-72 mt-2" />
      </div>

      <TableSkeleton
        columns={5}
        rows={5}
        headings={['Deal Name', 'Created Date', 'Amount', 'Status', 'Action']}
      />
    </div>
  )
}
