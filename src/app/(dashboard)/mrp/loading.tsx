import { Skeleton } from "@/components/ui/skeleton";

// MRPClient always renders a real BoardTable (dark theme), so this mirrors
// page.tsx's header + traffic-light summary + formula reference, plus a dark
// table skeleton matching its columns.
const HEADINGS = [
  "Status",
  "SKU",
  "Product",
  "In Stock",
  "In Transit",
  "On Order",
  "CIP",
  "Pipeline Demand",
  "LT Demand",
  "Safety Stock",
  "Trigger",
  "Run Rate/day",
];

export default function MRPLoading() {
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

      {/* Traffic light summary */}
      <div className="grid grid-cols-3 gap-3 mb-6">
        <div className="bg-red-950/30 border border-red-900/40 rounded-xl px-5 py-4">
          <div className="flex items-center gap-2 mb-1">
            <div className="w-3 h-3 rounded-full bg-red-400" />
            <Skeleton className="h-3 w-24" />
          </div>
          <Skeleton className="h-9 w-10 mt-1" />
          <Skeleton className="h-3 w-28 mt-1.5" />
        </div>
        <div className="bg-yellow-950/20 border border-yellow-900/40 rounded-xl px-5 py-4">
          <div className="flex items-center gap-2 mb-1">
            <div className="w-3 h-3 rounded-full bg-yellow-400" />
            <Skeleton className="h-3 w-24" />
          </div>
          <Skeleton className="h-9 w-10 mt-1" />
          <Skeleton className="h-3 w-28 mt-1.5" />
        </div>
        <div className="bg-emerald-950/20 border border-emerald-900/40 rounded-xl px-5 py-4">
          <div className="flex items-center gap-2 mb-1">
            <div className="w-3 h-3 rounded-full bg-emerald-400" />
            <Skeleton className="h-3 w-24" />
          </div>
          <Skeleton className="h-9 w-10 mt-1" />
          <Skeleton className="h-3 w-28 mt-1.5" />
        </div>
      </div>

      {/* Formula reference */}
      <div className="bg-[#1a1a2e] border border-blue-900/30 rounded-xl px-5 py-4 mb-6 space-y-2">
        <Skeleton className="h-3 w-32" />
        <Skeleton className="h-3 w-64" />
        <Skeleton className="h-3 w-72" />
        <Skeleton className="h-3 w-80" />
        <Skeleton className="h-3 w-60" />
      </div>

      {/* Table */}
      <Skeleton className="h-9 w-full rounded-lg mb-3" />
      <div className="overflow-auto rounded-lg border border-[#2a2a2a]">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-[#2a2a2a] bg-[#161616]">
              {HEADINGS.map((h) => (
                <th key={h} className="px-4 py-3 text-left text-xs font-medium text-[#6b7280] uppercase tracking-wider whitespace-nowrap">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: 5 }).map((_, r) => (
              <tr key={r} className="border-b border-[#1e1e1e] last:border-0">
                {HEADINGS.map((h, c) => (
                  <td key={c} className="px-4 py-3">
                    <Skeleton className="h-3 w-full max-w-[90px]" />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
