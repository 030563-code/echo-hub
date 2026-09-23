import Link from 'next/link'
import { requireCapability } from '@/lib/authz'
import { listCustomsBills } from '@/lib/customs/store.server'
import { listRow, TONE_CLASSES, type StatusChip } from '@/lib/customs/view'
import { formatDate, formatMoney } from '@/lib/utils'

/**
 * Customs: every Nippon Express invoice for a container into the US, read by Claude, checked, and
 * ready for Xero.
 *
 * Dean, 23 Sep 2026: "it should pull through to a new tab maybe under transport where only Dave
 * can see it. And it prefills what we need to fill in the same as it currently is under Bills in
 * Xero. The invoices should have the Invoice Number as a link to which shipment it is."
 *
 * Replaces Dave's "Arrived 2026" sheet: the duty, the fees and Nippon's charges per container are
 * here, worked from the entry itself, with the arithmetic checked.
 */

export const dynamic = 'force-dynamic'

function Chip({ chip }: { chip: StatusChip | null }) {
  if (!chip) return <span className="text-xs text-gray-400">—</span>
  return (
    <span className={`inline-flex whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${TONE_CLASSES[chip.tone]}`}>
      {chip.label}
    </span>
  )
}

export default async function CustomsPage() {
  await requireCapability('customs.manage')
  const rows = (await listCustomsBills()).map(listRow)

  const year = new Date().toISOString().slice(0, 4)
  const live = rows.filter((r) => r.xero.label !== 'A resend, not billed')
  const thisYear = live.filter((r) => r.invoiceDate?.startsWith(year))
  const dutyThisYear = thisYear.reduce((sum, r) => sum + (r.customs ?? 0), 0)
  const awaiting = live.filter((r) => r.awaitingApproval).length
  const needsLook = live.filter((r) => r.checks && r.checks.tone !== 'green').length
  const reading = live.filter((r) => r.reading.tone !== 'green').length

  return (
    <div className="p-6">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900" style={{ fontFamily: 'Varela Round, sans-serif' }}>
          Customs
        </h1>
        <p className="mt-1 max-w-3xl text-sm text-gray-500">
          Nippon Express duty and fees for every container into the US, read from the invoice and CBP&apos;s entry
          summary. Every figure is checked against CBP&apos;s rules before it reaches Xero.
        </p>
      </div>

      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[
          { label: 'Waiting for your approval', value: String(awaiting), tone: awaiting ? 'text-blue-700' : 'text-gray-900' },
          { label: 'Need a look', value: String(needsLook), tone: needsLook ? 'text-amber-700' : 'text-gray-900' },
          { label: `Duty and fees in ${year}`, value: formatMoney(dutyThisYear), tone: 'text-gray-900' },
          { label: 'Being read', value: String(reading), tone: 'text-gray-900' },
        ].map((tile) => (
          <div key={tile.label} className="rounded-lg border border-gray-200 bg-white px-4 py-3">
            <p className="mb-0.5 text-xs text-gray-500">{tile.label}</p>
            <p className={`text-2xl font-bold tabular-nums ${tile.tone}`}>{tile.value}</p>
          </div>
        ))}
      </div>

      {rows.length === 0 ? (
        <div className="rounded-xl border border-dashed border-gray-300 bg-white px-6 py-10 text-center">
          <p className="text-sm font-medium text-gray-900">No Nippon Express invoices yet</p>
          <p className="mt-1 text-sm text-gray-500">
            They arrive here from Dave&apos;s inbox as Nippon Express sends them.
          </p>
        </div>
      ) : (
        // relative: the hidden "Open" heading is positioned absolutely, and without a positioned
        // box to hold it, it escaped this scroller and widened the whole page.
        <div className="relative overflow-x-auto rounded-xl border border-gray-200 bg-white">
          <table className="min-w-full text-sm">
            <thead className="border-b border-gray-200 bg-gray-50 text-left text-xs font-semibold uppercase tracking-wide text-gray-500">
              <tr>
                <th className="px-3 py-3">Invoice</th>
                <th className="px-3 py-3">Container</th>
                <th className="px-3 py-3 text-right">Entered value</th>
                <th className="px-3 py-3 text-right">Duty and fees</th>
                <th className="px-3 py-3 text-right">Nippon&apos;s charges</th>
                <th className="px-3 py-3 text-right">Total</th>
                <th className="px-3 py-3">Status</th>
                <th className="px-3 py-3"><span className="sr-only">Open</span></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {rows.map((r) => (
                <tr key={r.id} className="align-top">
                  <td className="whitespace-nowrap px-3 py-3 font-medium">
                    {r.invoiceNumber ? (
                      r.spotId ? (
                        <Link
                          href={`/transport/${r.spotId}`}
                          className="text-[#025945] underline decoration-[#025945]/30 underline-offset-2 hover:decoration-[#025945]"
                          title={`Shipment SPOT ${r.spotId}`}
                        >
                          {r.invoiceNumber}
                        </Link>
                      ) : (
                        <span className="text-gray-900" title="Not linked to a shipment in Transport">
                          {r.invoiceNumber}
                        </span>
                      )
                    ) : (
                      <span className="text-gray-400">Not read yet</span>
                    )}
                    <p className="mt-0.5 text-xs font-normal text-gray-500">{formatDate(r.invoiceDate)}</p>
                  </td>
                  <td className="px-3 py-3 text-gray-700">
                    <span className="whitespace-nowrap tabular-nums">{r.container ?? '—'}</span>
                    {r.groupInvoices.length > 0 && (
                      <p className="mt-0.5 text-xs text-gray-500" title="The Group invoices on the entry">
                        {r.groupInvoices.join(', ')}
                      </p>
                    )}
                  </td>
                  <td className="whitespace-nowrap px-3 py-3 text-right tabular-nums text-gray-700">
                    {r.enteredValue != null ? formatMoney(r.enteredValue) : '—'}
                  </td>
                  <td className="whitespace-nowrap px-3 py-3 text-right tabular-nums text-gray-900">{formatMoney(r.customs)}</td>
                  <td className="whitespace-nowrap px-3 py-3 text-right tabular-nums text-gray-700">{formatMoney(r.service)}</td>
                  <td className="whitespace-nowrap px-3 py-3 text-right font-semibold tabular-nums text-gray-900">{formatMoney(r.total)}</td>
                  <td className="px-3 py-3">
                    <div className="flex flex-col items-start gap-1">
                      <Chip chip={r.checks ?? (r.reading.tone === 'green' ? null : r.reading)} />
                      <Chip chip={r.xero} />
                    </div>
                  </td>
                  <td className="whitespace-nowrap px-3 py-3 text-right">
                    <Link href={`/transport/customs/${r.id}`} className="text-sm font-medium text-gray-700 hover:text-gray-900">
                      Open
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
