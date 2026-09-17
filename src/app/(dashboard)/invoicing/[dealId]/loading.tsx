import { DetailSkeleton } from '@/components/ui/loading-skeleton'

// A single record under a list route. Without its own boundary this inherits the list's
// loading.tsx, which draws the LIST: opening one order flashed the board you just left.
export default function Loading() {
  return (
    <div className="p-6">
      <DetailSkeleton />
    </div>
  )
}
