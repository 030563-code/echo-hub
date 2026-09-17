import { PageSkeleton } from '@/components/ui/loading-skeleton'

// The approvals queue is a list, not the kanban board its parent loading.tsx draws.
export default function Loading() {
  return (
    <div className="p-6">
      <PageSkeleton rows={5} />
    </div>
  )
}
