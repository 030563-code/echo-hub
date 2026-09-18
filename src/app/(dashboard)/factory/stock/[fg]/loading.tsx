import { DetailSkeleton } from '@/components/ui/loading-skeleton'

// One product under the stock route. Without its own boundary this inherits the
// stock page's skeleton, which draws two tables the breakdown does not have.
export default function Loading() {
  return (
    <div className="p-6">
      <DetailSkeleton />
    </div>
  )
}
