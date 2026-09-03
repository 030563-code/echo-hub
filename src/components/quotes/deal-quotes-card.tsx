'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { ExternalLink, FileText, Pencil, RefreshCw } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { formatMoney, formatDate } from '@/lib/utils'
import { hubspotRecordUrl } from '@/lib/hubspot-links'
import { retryHubSpotQuote } from '@/app/actions/sales/publish-quote'
import { recallQuoteForEdit, republishEditedQuote } from '@/app/actions/sales/edit-quote'

/**
 * The HubSpot quotes published from the Hub for this deal.
 *
 * Before Phase B a generated quote left no trace in the Hub at all: the PDF was
 * downloaded to the rep's machine and attached to HubSpot, and the deal page
 * had nothing to show or reopen. Several quotes per deal are still expected,
 * because reps keep variants.
 *
 * A published quote can now be RECALLED and edited in place rather than
 * replaced. HubSpot clears hs_quote_link while the quote sits back in DRAFT and
 * restores the same url on republish (verified live 2026-09-03), so an edit
 * keeps the link and the number the customer already has. While a quote is
 * recalled its link genuinely does not work, which is why that row shouts.
 */

export interface DealQuoteRow {
  id: string
  hubspot_quote_id: string | null
  quote_number: string | null
  title: string | null
  status: 'draft' | 'editing' | 'published' | 'failed'
  failed_step: string | null
  error_message: string | null
  quote_link: string | null
  pdf_link: string | null
  amount: string | number | null
  hub_amount: string | number | null
  currency: string | null
  expires_on: string | null
  created_at: string
  created_by_label: string | null
  link_before_edit: string | null
  edit_count: number | null
  edited_at: string | null
}

const STATUS_CHIP: Record<DealQuoteRow['status'], { label: string; className: string }> = {
  published: { label: 'Published', className: 'bg-green-100 text-green-800 border-green-200' },
  // A draft row means a generate that started and has not finished, not a
  // deliberate draft. Amber rather than grey, because it wants attention.
  draft: { label: 'Unfinished', className: 'bg-amber-100 text-amber-800 border-amber-200' },
  editing: { label: 'Recalled, link offline', className: 'bg-amber-100 text-amber-900 border-amber-300' },
  failed: { label: 'Failed', className: 'bg-red-100 text-red-800 border-red-200' },
}

export function DealQuotesCard({
  dealId,
  quotes,
  canRetry,
}: {
  dealId: string
  quotes: DealQuoteRow[]
  canRetry: boolean
}) {
  const router = useRouter()
  const [retrying, setRetrying] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)

  // A recalled quote is NOT something Retry can finish: retryHubSpotQuote
  // resumes a generate, and this one needs republishing with the rep's edits.
  const unfinished = quotes.find((q) => q.status === 'draft' || q.status === 'failed')

  async function retry() {
    if (retrying) return
    setRetrying(true)
    try {
      const result = await retryHubSpotQuote(dealId)
      if (result.success) {
        toast.success('Quote published in HubSpot')
        router.refresh()
      } else {
        toast.error(result.error)
      }
    } finally {
      setRetrying(false)
    }
  }

  /** Pull a published quote back to draft and open the builder on it. */
  async function recall(quote: DealQuoteRow) {
    if (busyId) return
    setBusyId(quote.id)
    try {
      const result = await recallQuoteForEdit(quote.id)
      if (!result.success) {
        toast.error(result.error)
        // The guards read live HubSpot state, so a refusal usually means the
        // deal moved under the rep. Refresh so the screen agrees with it.
        router.refresh()
        return
      }
      router.push(`/quotes/create/${dealId}?editQuote=${result.quote.dealQuoteId}`)
    } finally {
      setBusyId(null)
    }
  }

  /**
   * Republish a quote whose republish failed, with no changes.
   *
   * The recovery for the one genuinely bad state: the quote is parked in DRAFT
   * with its link offline. Sends no lines, so the server republishes the stored
   * snapshot exactly as it stands.
   */
  async function republishAsIs(quote: DealQuoteRow) {
    if (busyId) return
    setBusyId(quote.id)
    try {
      const result = await republishEditedQuote({ dealQuoteId: quote.id })
      if (!result.success) {
        toast.error(result.error)
        return
      }
      if (result.quote.linkChanged) {
        toast.warning('HubSpot issued a NEW link, so the one already sent no longer works. Send the new link.', {
          duration: 15000,
        })
      } else {
        toast.success('Quote republished on the same link')
      }
      if (result.resyncError) toast.warning(result.resyncError, { duration: 15000 })
      router.refresh()
    } finally {
      setBusyId(null)
    }
  }

  return (
    <Card className="p-6 bg-white border-gray-200">
      <div className="mb-4 flex items-center justify-between">
        <h3 className="text-lg font-semibold text-gray-900">Quotes</h3>
        {canRetry && unfinished && (
          <Button size="sm" onClick={retry} disabled={retrying}>
            <RefreshCw className={`mr-1.5 h-4 w-4 ${retrying ? 'animate-spin' : ''}`} />
            {retrying ? 'Retrying...' : 'Retry quote'}
          </Button>
        )}
      </div>

      {quotes.length === 0 ? (
        <p className="text-sm text-gray-500">
          No HubSpot quote has been published from the Hub for this deal yet.
        </p>
      ) : (
        <ul className="space-y-3">
          {quotes.map((quote) => {
            const chip = STATUS_CHIP[quote.status]
            const hubspotUrl = hubspotRecordUrl('quote', quote.hubspot_quote_id)
            const total = quote.amount ?? quote.hub_amount
            return (
              <li key={quote.id} className="rounded border border-gray-100 bg-gray-50 p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium text-gray-900">
                    {quote.quote_number ?? quote.title ?? 'Quote'}
                  </span>
                  <span className={`rounded border px-2 py-0.5 text-xs ${chip.className}`}>{chip.label}</span>
                  <span className="ml-auto font-mono text-sm text-gray-900">
                    {total == null ? '—' : formatMoney(Number(total), quote.currency ?? 'USD')}
                  </span>
                </div>

                <p className="mt-1 text-xs text-gray-500">
                  {formatDate(quote.created_at)}
                  {quote.created_by_label ? ` by ${quote.created_by_label}` : ''}
                  {quote.expires_on ? `, expires ${quote.expires_on}` : ''}
                </p>

                {quote.status === 'failed' && quote.error_message && (
                  <p className="mt-2 rounded border border-red-200 bg-red-50 px-2 py-1 text-xs text-red-700">
                    Stopped at {quote.failed_step ?? 'an unknown step'}: {quote.error_message}
                  </p>
                )}

                {quote.status === 'editing' && (
                  <p className="mt-2 rounded border border-amber-300 bg-amber-50 px-2 py-1 text-xs text-amber-900">
                    {quote.error_message
                      ? `Republishing stopped at ${quote.failed_step ?? 'an unknown step'}: ${quote.error_message} The customer's link stays offline until it republishes.`
                      : 'Recalled for editing, so the link the customer has is offline until it is republished.'}
                  </p>
                )}

                {quote.status === 'published' && (quote.edit_count ?? 0) > 0 && (
                  <p className="mt-1 text-xs text-gray-500">
                    Edited {quote.edit_count} {quote.edit_count === 1 ? 'time' : 'times'}
                    {quote.edited_at ? `, last on ${formatDate(quote.edited_at)}` : ''}, on the same link.
                  </p>
                )}

                <div className="mt-2 flex flex-wrap gap-2">
                  {quote.status === 'editing' && canRetry && (
                    <>
                      <Link href={`/quotes/create/${dealId}?editQuote=${quote.id}`}>
                        <Button size="sm">
                          <Pencil className="mr-1.5 h-4 w-4" />
                          Continue editing
                        </Button>
                      </Link>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => republishAsIs(quote)}
                        disabled={busyId !== null}
                      >
                        <RefreshCw className={`mr-1.5 h-4 w-4 ${busyId === quote.id ? 'animate-spin' : ''}`} />
                        {busyId === quote.id ? 'Republishing...' : 'Republish now'}
                      </Button>
                    </>
                  )}
                  {quote.status === 'published' && canRetry && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => recall(quote)}
                      disabled={busyId !== null}
                    >
                      <Pencil className="mr-1.5 h-4 w-4" />
                      {busyId === quote.id ? 'Recalling...' : 'Recall and edit'}
                    </Button>
                  )}
                  {quote.quote_link && (
                    <a href={quote.quote_link} target="_blank" rel="noopener noreferrer">
                      <Button size="sm" variant="outline">
                        <ExternalLink className="mr-1.5 h-4 w-4" />
                        Open quote
                      </Button>
                    </a>
                  )}
                  {quote.pdf_link && (
                    <a href={quote.pdf_link} target="_blank" rel="noopener noreferrer">
                      <Button size="sm" variant="outline">
                        <FileText className="mr-1.5 h-4 w-4" />
                        PDF
                      </Button>
                    </a>
                  )}
                  {hubspotUrl && (
                    <a href={hubspotUrl} target="_blank" rel="noopener noreferrer">
                      <Button size="sm" variant="outline">
                        <ExternalLink className="mr-1.5 h-4 w-4" />
                        In HubSpot
                      </Button>
                    </a>
                  )}
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </Card>
  )
}
