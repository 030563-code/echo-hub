import Link from 'next/link'
import { ChevronLeft, ChevronRight } from 'lucide-react'

interface PaginationNavProps {
  currentPage: number
  hasNextPage: boolean
  basePath: string
  /** Cursor stack: comma-separated after-cursors for pages 2, 3, 4 ... */
  cursorStack: string
  /** The after-cursor for the NEXT page (returned from current HubSpot fetch) */
  nextAfter?: string
}

/**
 * URL structure:
 *   ?page=1                             — first page, no cursor needed
 *   ?page=2&cursors=<c1>                — page 2, uses c1
 *   ?page=3&cursors=<c1>,<c2>           — page 3, uses c2
 *
 * The `cursors` param is the stack of after-cursors accumulated so far.
 * To go to the next page we append nextAfter to the stack.
 * To go to the previous page we pop the last item from the stack.
 */
export function PaginationNav({
  currentPage,
  hasNextPage,
  basePath,
  cursorStack,
  nextAfter,
}: PaginationNavProps) {
  const cursors = cursorStack ? cursorStack.split(',').filter(Boolean) : []

  // Build next page URL: push nextAfter onto cursor stack
  const nextCursors = nextAfter ? [...cursors, nextAfter].join(',') : ''
  const nextHref = `${basePath}?page=${currentPage + 1}&cursors=${encodeURIComponent(nextCursors)}`

  // Build previous page URL: pop last cursor from stack
  const prevCursors = cursors.slice(0, -1).join(',')
  const prevPage = currentPage - 1
  const prevHref =
    prevPage <= 1
      ? basePath
      : `${basePath}?page=${prevPage}&cursors=${encodeURIComponent(prevCursors)}`

  const isFirstPage = currentPage <= 1
  const showPagination = !isFirstPage || hasNextPage

  if (!showPagination) return null

  return (
    <div className="flex items-center justify-between pt-4">
      <div className="flex items-center gap-2">
        {isFirstPage ? (
          <span className="inline-flex items-center gap-1 px-3 py-1.5 text-sm font-medium text-gray-400 border border-gray-200 rounded cursor-not-allowed select-none">
            <ChevronLeft className="w-4 h-4" />
            Previous
          </span>
        ) : (
          <Link
            href={prevHref}
            className="inline-flex items-center gap-1 px-3 py-1.5 text-sm font-medium text-gray-700 border border-gray-300 rounded hover:bg-gray-50 transition-colors"
          >
            <ChevronLeft className="w-4 h-4" />
            Previous
          </Link>
        )}
      </div>

      <span className="text-sm text-gray-500">Page {currentPage}</span>

      <div className="flex items-center gap-2">
        {hasNextPage ? (
          <Link
            href={nextHref}
            className="inline-flex items-center gap-1 px-3 py-1.5 text-sm font-medium text-gray-700 border border-gray-300 rounded hover:bg-gray-50 transition-colors"
          >
            Next
            <ChevronRight className="w-4 h-4" />
          </Link>
        ) : (
          <span className="inline-flex items-center gap-1 px-3 py-1.5 text-sm font-medium text-gray-400 border border-gray-200 rounded cursor-not-allowed select-none">
            Next
            <ChevronRight className="w-4 h-4" />
          </span>
        )}
      </div>
    </div>
  )
}
