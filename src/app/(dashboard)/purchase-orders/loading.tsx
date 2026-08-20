import { Skeleton } from "@/components/ui/skeleton";

// PurchasingClient defaults to the kanban view (not a table), so this mirrors
// the header + stats strip from page.tsx plus a kanban-column skeleton rather
// than forcing a table.
const KANBAN_COLUMNS = 7;

export default function PurchaseOrdersLoading() {
  return (
    <div
      className="p-6"
      role="status"
      style={{ '--skeleton-bg': 'rgba(255,255,255,0.10)' } as React.CSSProperties}
    >
      <span className="sr-only">Loading…</span>

      {/* Header */}
      <div className="mb-6">
        <Skeleton className="h-7 w-64" />
        <Skeleton className="h-4 w-80 mt-2" />
      </div>

      {/* Stats strip */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="bg-[#1e1e1e] border border-[#2a2a2a] rounded-lg px-4 py-3">
            <Skeleton className="h-3 w-20 mb-2" />
            <Skeleton className="h-6 w-10" />
          </div>
        ))}
      </div>

      {/* View toggle */}
      <div className="flex items-center gap-2 mb-4">
        <Skeleton className="h-8 w-40 rounded-lg" />
        <Skeleton className="h-3 w-16" />
      </div>

      {/* Kanban columns */}
      <div className="flex gap-3 overflow-x-auto pb-4">
        {Array.from({ length: KANBAN_COLUMNS }).map((_, col) => (
          <div key={col} className="flex-shrink-0 w-64">
            <div className="flex items-center justify-between px-3 py-2 mb-2">
              <Skeleton className="h-3 w-20" />
              <Skeleton className="h-4 w-5 rounded-full" />
            </div>
            <div className="space-y-2">
              {Array.from({ length: 2 }).map((_, card) => (
                <div key={card} className="bg-[#1e1e1e] border border-[#2a2a2a] rounded-lg p-3">
                  <Skeleton className="h-3 w-24 mb-2" />
                  <Skeleton className="h-3 w-16" />
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
