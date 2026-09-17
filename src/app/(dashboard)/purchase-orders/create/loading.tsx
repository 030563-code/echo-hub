import { Skeleton } from '@/components/ui/skeleton'
import { FormSkeleton } from '@/components/ui/loading-skeleton'

// Raise a purchase order is a form, not the board. See the note in the specification loader.
export default function Loading() {
  return (
    <div className="p-6" role="status">
      <span className="sr-only">Loading…</span>
      <Skeleton className="h-4 w-32" />
      <div className="mt-4 mb-6">
        <Skeleton className="h-6 w-80 max-w-full" />
        <Skeleton className="mt-2 h-3.5 w-full max-w-2xl" />
      </div>
      <FormSkeleton groups={2} rows={4} />
    </div>
  )
}
