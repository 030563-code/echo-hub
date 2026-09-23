import Link from 'next/link'
import { Plus } from 'lucide-react'

/**
 * The way into a new deal, top right on the Board and the Deals tabs.
 *
 * Dean, 23 Sep 2026: "The + Create Deal button should be more prominent and also be in the
 * 'Board' tab currently it only sits in the 'Deals' tab." Larger, rounded and lifted off the page,
 * in the same place on both tabs.
 *
 * Black on Echo orange, the Hub icon's own pair. White on this orange is 2.8:1 and fails contrast;
 * black is 7.6:1.
 *
 * Shown only to someone who can create a deal: the page behind it requires quotes.create, and a
 * button that sends a view-only user back to the dashboard is worse than no button.
 */
export function CreateDealButton() {
  return (
    <Link
      href="/quotes/create/manual"
      className="inline-flex w-full shrink-0 items-center justify-center gap-2 rounded-lg bg-echo-orange px-6 py-3 text-base font-bold uppercase tracking-wider text-black shadow-md transition hover:bg-echo-orange-hover hover:shadow-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-echo-orange/60 focus-visible:ring-offset-2 sm:w-auto"
    >
      <Plus className="h-5 w-5" strokeWidth={3} aria-hidden="true" />
      Create Deal
    </Link>
  )
}
