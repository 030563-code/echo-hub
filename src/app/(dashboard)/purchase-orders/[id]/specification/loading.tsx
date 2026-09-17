import { Skeleton } from '@/components/ui/skeleton'
import { FormSkeleton } from '@/components/ui/loading-skeleton'

// The specification editor. Without this the nearest boundary is purchase-orders/loading.tsx,
// which draws the KANBAN BOARD: navigating into a form flashed the board you just left.
export default function Loading() {
  return (
    <div className="mx-auto max-w-5xl px-4 py-6 sm:px-6" role="status">
      <span className="sr-only">Loading…</span>
      <Skeleton className="h-4 w-32" />
      <div className="mt-4 mb-6">
        <Skeleton className="h-6 w-80 max-w-full" />
        <Skeleton className="mt-2 h-3.5 w-full max-w-2xl" />
      </div>
      <FormSkeleton groups={3} rows={5} />
    </div>
  )
}
