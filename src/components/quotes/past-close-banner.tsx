import Link from 'next/link'
import { AlertTriangle, ExternalLink } from 'lucide-react'
import { pastCloseDealsForViewer, type PastCloseSummary } from '@/lib/past-close.server'
import { hubspotRecordUrl } from '@/lib/hubspot-links'
import { formatDate, formatMoney } from '@/lib/utils'

/** "7 of your open deals are past their close date." or "200 open USA deals are past ...". */
function headline({ scope, organisation, total }: PastCloseSummary): string {
  const one = total === 1
  if (scope === 'organisation') {
    return one
      ? `1 open ${organisation} deal is past its close date.`
      : `${total} open ${organisation} deals are past their close date.`
  }
  return one ? '1 of your open deals is past its close date.' : `${total} of your open deals are past their close date.`
}

/**
 * The red reminder above the Quotes tabs: open deals whose close date has passed.
 *
 * Dean, 23 Sep 2026: "a red warning on the top of the deals board across all tabs teling them they
 * have deals open and past ecpiry date that need fixing", by the rule the CSO applies (see
 * src/lib/past-close.ts). The same deals reach the person from the CSO, so the Hub and the CSO
 * never disagree about which ones need a decision. A salesperson sees their own; an admin sees
 * every rep's in the organisation they are looking at, with whose each one is.
 *
 * Each deal opens in the Hub, where it can be closed won or lost, and in HubSpot, where the close
 * date is edited: the Hub has no close date field. The list is folded away so it does not push the
 * tab down; a native details element, so its open state survives moving between tabs without any
 * client state.
 *
 * Renders nothing when there is nothing to fix, and nothing when HubSpot could not be read.
 */
export async function PastCloseBanner() {
  const summary = await pastCloseDealsForViewer()
  if (!summary || summary.total === 0) return null

  const { total, deals } = summary
  const one = total === 1

  return (
    <section
      aria-label="Deals past their close date"
      data-testid="past-close-banner"
      className="mb-4 rounded-lg border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-900"
    >
      <div className="flex items-start gap-3">
        <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-red-600" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p className="font-semibold">{headline(summary)}</p>
          <p className="mt-0.5">
            {one
              ? 'Give it a new close date, or close it as won or lost.'
              : 'Give each one a new close date, or close it as won or lost.'}
          </p>

          <details className="mt-2">
            <summary className="cursor-pointer font-medium text-red-800 hover:text-red-950">
              {one ? 'Show the deal' : `Show the ${total} deals`}
            </summary>
            <ul className="mt-2 divide-y divide-red-100 overflow-hidden rounded border border-red-200 bg-white">
              {deals.map((deal) => {
                const hubspot = hubspotRecordUrl('deal', deal.id)
                return (
                  <li
                    key={deal.id}
                    className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-3 py-2"
                  >
                    <Link
                      href={`/quotes/deals/${deal.id}`}
                      className="min-w-0 break-words font-medium text-gray-900 hover:underline"
                    >
                      {deal.name}
                    </Link>
                    <span className="flex flex-wrap items-baseline gap-x-3 text-xs text-gray-600 tabular-nums">
                      {deal.owner && <span className="font-medium text-gray-800">{deal.owner}</span>}
                      <span>
                        Close date {formatDate(deal.closeDay)}, {deal.daysPast} {deal.daysPast === 1 ? 'day' : 'days'} ago
                      </span>
                      {deal.amount !== null && <span>{formatMoney(deal.amount, deal.currency)}</span>}
                      {hubspot && (
                        <a
                          href={hubspot}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-0.5 font-medium text-red-800 hover:text-red-950 hover:underline"
                        >
                          Change the date in HubSpot
                          <ExternalLink className="h-3 w-3" aria-hidden="true" />
                        </a>
                      )}
                    </span>
                  </li>
                )
              })}
            </ul>
            {total > deals.length && (
              <p className="mt-2 text-xs">
                Showing the {deals.length} largest by amount, of {total}.
              </p>
            )}
          </details>
        </div>
      </div>
    </section>
  )
}
