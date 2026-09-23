'use client'

import { usePathname } from 'next/navigation'
import { isQuotesListRoute } from '@/lib/page-drafts'

/**
 * Shows its children on the six Quotes tabs (Board, Deals, Sent, Accepted, Won, All) and nowhere
 * else under /quotes: not on a deal, and not in the quote builder, where a reminder about other
 * deals is in the way.
 *
 * Decided in the browser because the Quotes layout is not rendered again when a person moves
 * between tabs, so the server cannot know which tab is showing.
 */
export function QuotesTabsOnly({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  return isQuotesListRoute(pathname) ? <>{children}</> : null
}
