import { Skeleton } from "@/components/ui/skeleton";

// BomSection defaults to the "orders" tab, which renders a list of collapsed
// OrderCard rows (not a table), so this mirrors page.tsx's header plus that
// card-list shape rather than forcing a table.
export default function BomLoading() {
  return (
    <div
      className="p-6"
      role="status"
      style={{ '--skeleton-bg': 'rgba(255,255,255,0.10)' } as React.CSSProperties}
    >
      <span className="sr-only">Loading…</span>

      {/* Header */}
      <div className="mb-6">
        <Skeleton className="h-7 w-72" />
        <Skeleton className="h-4 w-96 mt-2" />
      </div>

      {/* Tab toggle */}
      <div className="flex items-center bg-[#1e1e1e] border border-[#2a2a2a] rounded-lg p-0.5 w-fit mb-5">
        <Skeleton className="h-7 w-32 rounded-md" />
        <Skeleton className="h-7 w-28 rounded-md ml-0.5" />
      </div>

      {/* Order cards */}
      <div className="space-y-3">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="bg-[#161616] border border-[#2a2a2a] rounded-xl px-5 py-4 flex items-center justify-between gap-4">
            <div className="min-w-0 space-y-2">
              <Skeleton className="h-3.5 w-32" />
              <Skeleton className="h-3 w-48" />
            </div>
            <div className="flex items-center gap-5 flex-shrink-0">
              <div className="space-y-1.5 text-right">
                <Skeleton className="h-2.5 w-24 ml-auto" />
                <Skeleton className="h-4 w-16 ml-auto" />
              </div>
              <div className="space-y-1.5 text-right">
                <Skeleton className="h-2.5 w-24 ml-auto" />
                <Skeleton className="h-4 w-16 ml-auto" />
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
