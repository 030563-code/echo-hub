import { DetailSkeleton } from '@/components/ui/loading-skeleton'

// Correcting one bill's reading. Without its own boundary this inherits the bill page's, which is
// the right shape, but the guard asks every form route for its own.
export default function Loading() {
  return (
    <div className="p-6">
      <DetailSkeleton cards={3} />
    </div>
  )
}
