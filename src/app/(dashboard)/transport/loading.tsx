import { Skeleton } from "@/components/ui/skeleton";

// ShippingClient always renders a real BoardTable (dark theme), so this mirrors
// page.tsx's header + stats strip plus a dark table skeleton matching its columns.
const HEADINGS = [
  "Spot ID",
  "Container",
  "SKU",
  "Product",
  "Qty",
  "Depot",
  "Status",
  "Shipped",
  "ETA",
  "PO Ref",
];

export default function TransportLoading() {
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

      {/* Toolbar */}
      <div className="flex items-center justify-between mb-4">
        <Skeleton className="h-3 w-24" />
        <Skeleton className="h-8 w-36 rounded-lg" />
      </div>

      {/* Search bar */}
      <Skeleton className="h-9 w-full rounded-lg mb-3" />

      {/* Table */}
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
                    <Skeleton className="h-3 w-full max-w-[100px]" />
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
