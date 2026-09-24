import Link from 'next/link'
import { AlertTriangle, ArrowRight } from 'lucide-react'
import { displayPoNumber, legLabel } from '@/lib/po-number'
import type { XeroSendFailure } from '@/lib/po-xero-send'

/**
 * Approved purchase orders that should be in Xero and are not, where approvers look.
 *
 * This is the alert. Every way the Hub tells anybody anything about a purchase order goes out
 * through n8n, to Bamida, SRO or Cargo Partner, with wording n8n picks, so there is no channel
 * that would still work when n8n is the thing failing. The approvals page and the dashboard are
 * where the people who can fix it already look, so it is said there, every time they look, until
 * the order is in Xero.
 *
 * `compact` is the dashboard's version: the first five, and the way to the rest.
 */
export default function XeroSendFailures({ failures, compact = false }: { failures: XeroSendFailure[]; compact?: boolean }) {
  if (failures.length === 0) return null
  const shown = compact ? failures.slice(0, 5) : failures
  const one = failures.length === 1

  return (
    <section role="alert" className="rounded-xl border border-red-200 bg-red-50 p-4">
      <h2 className="flex items-center gap-2 text-sm font-semibold text-red-900">
        <AlertTriangle className="h-4 w-4 flex-shrink-0" />
        {one ? '1 approved purchase order is not in Xero' : `${failures.length} approved purchase orders are not in Xero`}
      </h2>
      <p className="mt-1 text-xs text-red-800">
        No Xero purchase order came back for {one ? 'it' : 'these'}, and nothing will send {one ? 'it' : 'them'} again by
        itself. Open {one ? 'it' : 'one'} to see why and to send it to Xero again.
      </p>
      <ul className="mt-3 space-y-2">
        {shown.map((failure) => (
          <li key={failure.id}>
            <Link
              href={`/purchase-orders/${failure.id}`}
              className="group block rounded-lg border border-red-200 bg-white px-3 py-2 transition-colors hover:border-red-300"
            >
              <span className="flex items-center justify-between gap-2">
                <span className="font-mono text-sm text-gray-900">{displayPoNumber(failure.po_number)}</span>
                <span className="flex items-center gap-1.5">
                  <span className="rounded bg-gray-100 px-1.5 py-0.5 text-[10px] text-gray-600">{legLabel(failure.leg)}</span>
                  <ArrowRight className="h-3.5 w-3.5 text-gray-400 transition-colors group-hover:text-gray-700" />
                </span>
              </span>
              <span className="mt-1 block text-xs text-red-800">{failure.message}</span>
            </Link>
          </li>
        ))}
      </ul>
      {compact && failures.length > shown.length && (
        <Link href="/purchase-orders/approvals" className="mt-3 inline-block text-xs font-medium text-red-900 underline">
          See all {failures.length} on PO Approvals
        </Link>
      )}
    </section>
  )
}
