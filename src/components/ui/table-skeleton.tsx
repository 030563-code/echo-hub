import { Skeleton } from './skeleton'

export function TableSkeleton({
  columns,
  rows = 5,
  headings,
}: {
  columns: number
  rows?: number
  headings?: string[]
}) {
  return (
    <div className="bg-white border border-gray-200 rounded-lg overflow-hidden shadow-sm" role="status">
      <span className="sr-only">Loading…</span>
      <table className="w-full text-left text-sm">
        <thead className="bg-black text-white uppercase text-xs tracking-wider">
          <tr>
            {Array.from({ length: columns }).map((_, i) => (
              <th key={i} className="px-6 py-4 font-medium">
                {headings?.[i] ?? ''}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {Array.from({ length: rows }).map((_, r) => (
            <tr key={r}>
              {Array.from({ length: columns }).map((_, c) => (
                <td key={c} className="px-6 py-4">
                  <Skeleton className="h-4 w-full max-w-[140px]" />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
