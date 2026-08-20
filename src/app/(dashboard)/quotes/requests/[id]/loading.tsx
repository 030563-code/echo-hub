import { Skeleton } from '@/components/ui/skeleton'

// Deal detail page — heading skeleton plus card-shaped skeletons matching the
// Deal Information / Line Items / Associations cards.
export default function QuoteRequestDetailsLoading() {
  return (
    <div className="max-w-5xl mx-auto space-y-6">
      <div className="flex items-center gap-4 mb-6">
        <Skeleton className="h-8 w-40" />
      </div>

      <div className="flex items-start justify-between">
        <div>
          <Skeleton className="h-8 w-72" />
          <Skeleton className="h-4 w-48 mt-2" />
        </div>
        <Skeleton className="h-9 w-32" />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <div className="md:col-span-2 space-y-6">
          <Skeleton className="h-40 w-full" />
          <Skeleton className="h-56 w-full" />
        </div>
        <div className="space-y-6">
          <Skeleton className="h-64 w-full" />
        </div>
      </div>
    </div>
  )
}
