/**
 * Shimmer placeholder used by the route-level loading.tsx screens.
 *
 * The colour comes from --skeleton-bg (light grey by default) rather than a
 * Tailwind class so the dark board pages (PO, Transport, BOM, MRP) can retheme
 * every skeleton on the page by setting that variable once on their root —
 * a per-class override would depend on Tailwind's stylesheet order, which is
 * not something a caller can rely on.
 */
export function Skeleton({ className = '' }: { className?: string }) {
  return (
    <div
      className={`animate-pulse rounded ${className}`}
      style={{ backgroundColor: 'var(--skeleton-bg, #e5e7eb)' }}
      aria-hidden="true"
    />
  )
}
