import { DetailSkeleton } from '@/components/ui/loading-skeleton'

// One customs bill. Without its own boundary this inherits Transport's, which draws the
// shipment list over the top of a bill.
export default function Loading() {
  return (
    <div className="p-6">
      <DetailSkeleton cards={4} />
    </div>
  )
}
