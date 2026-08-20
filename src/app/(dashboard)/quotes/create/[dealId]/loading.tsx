import { Skeleton } from '@/components/ui/skeleton'

// Quote builder — simple two-column skeleton roughly matching CreateQuoteForm's shape.
export default function CreateQuoteLoading() {
  return (
    <div className="max-w-7xl mx-auto space-y-6">
      <div className="flex items-center gap-4 mb-6">
        <Skeleton className="h-8 w-32" />
        <Skeleton className="h-7 w-56" />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <div className="md:col-span-2 space-y-6">
          <Skeleton className="h-64 w-full" />
          <Skeleton className="h-48 w-full" />
        </div>
        <div className="space-y-6">
          <Skeleton className="h-40 w-full" />
          <Skeleton className="h-32 w-full" />
        </div>
      </div>
    </div>
  )
}
