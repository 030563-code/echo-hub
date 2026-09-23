import { PageSkeleton } from '@/components/ui/loading-skeleton'

// The customs list is a table, not the shipment board Transport's own skeleton draws.
export default function Loading() {
  return (
    <div className="p-6">
      <PageSkeleton rows={8} />
    </div>
  )
}
