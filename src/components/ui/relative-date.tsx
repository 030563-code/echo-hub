'use client'

import { useViewerTimeZone } from '@/hooks/use-viewer-time-zone'
import { formatRelative } from '@/lib/utils'

/**
 * "3d ago", or the date, for a page that renders on the server as well as in
 * the browser.
 *
 * The server render and the render that hydrates it both show the plain date in
 * UTC, so React finds the same text on each side. Once the page has hydrated it
 * reads the reader's clock and zone. A page reached by client-side navigation
 * does that on its first render. A component rather than a call, so a server
 * component (the purchase order page's timeline) or a table column defined
 * outside any component can use it too.
 */
export function RelativeDate({ value }: { value: string | null | undefined }) {
  const timeZone = useViewerTimeZone()
  return formatRelative(value ?? null, timeZone)
}
