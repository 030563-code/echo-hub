import Link from 'next/link'
import { notFound } from 'next/navigation'
import { AlertTriangle, ArrowLeft, CircleAlert, ExternalLink } from 'lucide-react'
import { requireCapability } from '@/lib/authz'
import { groupBillsOf, loadCustomsBill, xeroLinesOf } from '@/lib/customs/store.server'
import { checkPackage } from '@/lib/customs/checks'
import { buildXeroBill } from '@/lib/customs/xero-bill'
import { chargeLabel, serviceChargesOf } from '@/lib/customs/nippon-invoice'
import { checksChip, packageFrom, readingChip, TONE_CLASSES, xeroChip, type StatusChip } from '@/lib/customs/view'
import { formatDate, formatMoney } from '@/lib/utils'
import { CustomsBillActions } from './customs-bill-actions'

/**
 * One Nippon Express invoice: what Claude read, whether it adds up, which shipment it is, and the
 * bill as it goes to Xero. Approving here authorises it in Xero.
 */

export const dynamic = 'force-dynamic'

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const pct = (rate: number) => `${(Math.round(rate * 10000) / 100).toFixed(2).replace(/\.?0+$/, '')}%`

function Chip({ chip }: { chip: StatusChip | null }) {
  if (!chip) return null
  return (
    <span className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset ${TONE_CLASSES[chip.tone]}`}>
      {chip.label}
    </span>
  )
}

function Card({ title, children, hint }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-gray-200 bg-white p-5">
      <h2 className="text-base font-semibold text-gray-900" style={{ fontFamily: 'Varela Round, sans-serif' }}>
        {title}
      </h2>
      {hint && <p className="mt-0.5 text-sm text-gray-500">{hint}</p>}
      <div className="mt-4">{children}</div>
    </section>
  )
}

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-gray-500">{label}</dt>
      <dd className="mt-0.5 break-words text-sm text-gray-900">{value || '—'}</dd>
    </div>
  )
}

export default async function CustomsBillPage({ params }: { params: Promise<{ id: string }> }) {
  await requireCapability('customs.manage')
  const { id } = await params
  if (!uuid.test(id)) notFound()
  const row = await loadCustomsBill(id)
  if (!row) notFound()

  const pkg = row.ocr_status === 'done' ? packageFrom(row.extraction) : null
  const check = pkg ? checkPackage(pkg) : null
  const groupBills = groupBillsOf(row)
  const draft = pkg ? buildXeroBill(pkg, groupBills) : null
  const inXero = xeroLinesOf(row)
  const status = (row.xero_status ?? '').toUpperCase()

  const canApprove = Boolean(row.xero_invoice_id) && !row.duplicate_of && (status === 'DRAFT' || status === 'SUBMITTED')
  const canMakeDraft = row.source === 'email' && Boolean(pkg) && !row.xero_invoice_id && !row.duplicate_of
  const canReadAgain = row.ocr_status === 'failed' || row.ocr_status === 'pending' || (check?.worst === 'error')

  return (
    <div className="p-6">
      <Link
        href="/transport/customs"
        className="mb-4 inline-flex items-center gap-1.5 text-sm text-gray-500 transition-colors hover:text-gray-900"
      >
        <ArrowLeft className="h-4 w-4" /> All customs bills
      </Link>

      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900" style={{ fontFamily: 'Varela Round, sans-serif' }}>
            {row.invoice_number ?? row.file_name}
          </h1>
          <p className="mt-1 text-sm text-gray-500">
            Nippon Express USA{pkg?.invoice.office ? ` · ${pkg.invoice.office}` : ''}
            {row.invoice_date ? ` · ${formatDate(row.invoice_date)}` : ''}
            {row.source === 'xero_history' ? ' · read from the bill already in Xero' : ''}
          </p>
        </div>
        <div className="text-right">
          <p className="text-xs text-gray-500">Invoice total</p>
          <p className="text-2xl font-bold tabular-nums text-gray-900">{formatMoney(row.invoice_total)}</p>
        </div>
      </div>

      <div className="mb-5 flex flex-wrap items-center gap-2">
        <Chip chip={check ? checksChip(check) : readingChip(row)} />
        <Chip chip={xeroChip(row, pkg)} />
        {row.spot_id ? (
          <Link
            href={`/transport/${row.spot_id}`}
            className="inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium text-[#025945] ring-1 ring-inset ring-[#025945]/30 hover:bg-[#025945]/5"
          >
            Shipment SPOT {row.spot_id}
          </Link>
        ) : (
          row.ocr_status === 'done' && (
            <span className="text-xs text-gray-500">Not linked to a shipment in Transport</span>
          )
        )}
        {row.xero_invoice_id && (
          <a
            href={`https://go.xero.com/AccountsPayable/View.aspx?InvoiceID=${row.xero_invoice_id}`}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-xs font-medium text-gray-600 hover:text-gray-900"
          >
            Open in Xero <ExternalLink className="h-3 w-3" />
          </a>
        )}
      </div>

      <div className="mb-5">
        <CustomsBillActions
          billId={row.id}
          canApprove={canApprove}
          canMakeDraft={canMakeDraft}
          canReadAgain={canReadAgain}
          totalLabel={formatMoney(row.invoice_total)}
        />
        {canMakeDraft && pkg?.is_invoice === false && (
          <p className="mt-2 text-sm text-gray-600">
            Claude says this PDF is not a Nippon Express invoice, so no draft was made in Xero. Make one only if it is a bill.
          </p>
        )}
        {canMakeDraft && pkg?.is_invoice !== false && check?.worst === 'error' && (
          <p className="mt-2 text-sm text-gray-600">
            No draft was made in Xero, because of what is flagged below. Make the draft once you are happy with it.
          </p>
        )}
      </div>

      {row.ocr_status === 'failed' && (
        <div className="mb-5 flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3">
          <CircleAlert className="mt-0.5 h-4 w-4 shrink-0 text-red-600" />
          <p className="text-sm text-red-900">Claude could not read this PDF: {row.ocr_error ?? 'no reason given'}.</p>
        </div>
      )}
      {row.xero_error && (
        <div className="mb-5 flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3">
          <CircleAlert className="mt-0.5 h-4 w-4 shrink-0 text-red-600" />
          <p className="text-sm text-red-900">Xero: {row.xero_error}</p>
        </div>
      )}
      {row.duplicate_of && (
        <div className="mb-5 rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 text-sm text-gray-700">
          This PDF is a second copy of an invoice already here.{' '}
          <Link href={`/transport/customs/${row.duplicate_of}`} className="font-medium underline">
            Open the first one
          </Link>
          . It is never billed twice.
        </div>
      )}

      {check && check.checks.length > 0 && (
        <div className="mb-5 space-y-2">
          {check.checks.map((c, i) => (
            <div
              key={`${c.code}-${i}`}
              className={`flex items-start gap-2 rounded-xl border px-4 py-3 ${c.level === 'error' ? 'border-red-200 bg-red-50' : 'border-amber-200 bg-amber-50'}`}
            >
              <AlertTriangle className={`mt-0.5 h-4 w-4 shrink-0 ${c.level === 'error' ? 'text-red-600' : 'text-amber-600'}`} />
              <p className={`text-sm ${c.level === 'error' ? 'text-red-900' : 'text-amber-900'}`}>{c.message}</p>
            </div>
          ))}
        </div>
      )}

      {!pkg ? (
        <Card title="Being read" hint="Claude is reading the PDF. This page fills in when it is done, usually within a minute or two.">
          <p className="text-sm text-gray-600">{row.file_name}</p>
        </Card>
      ) : (
        <div className="space-y-5">
          {/* The bill beside what it is made from; the entry below at full width, since its rates
              and the rule each line is checked against need the room. */}
          <div className="grid items-start gap-5 xl:grid-cols-2">
            {draft && (
              <Card
                title="The bill for Xero"
                hint="Prefilled the way it is entered under Bills in Echo Barrier USA LLC. Each Group invoice's duty goes to the inventory clearing account its own bill is coded to."
              >
                <dl className="mb-4 grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4 xl:grid-cols-2">
                  <Field label="From" value={draft.contactName} />
                  <Field label="Bill number" value={draft.invoiceNumber} />
                  <Field label="Date" value={formatDate(draft.date)} />
                  <Field label="Due" value={`${formatDate(draft.dueDate)} (C.O.D.)`} />
                </dl>
                <div className="overflow-x-auto">
                  <table className="min-w-full text-sm">
                    <thead className="text-left text-xs font-semibold uppercase tracking-wide text-gray-500">
                      <tr>
                        <th className="py-2 pr-4">Description</th>
                        <th className="py-2 pr-4">Account</th>
                        <th className="py-2 text-right">Amount</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      {draft.lines.map((l, i) => (
                        <tr key={i}>
                          <td className="py-2 pr-4 text-gray-900">{l.description}</td>
                          <td className="py-2 pr-4 tabular-nums text-gray-700">
                            {l.accountCode ?? <span className="font-medium text-amber-700">Choose in Xero</span>}
                          </td>
                          <td className="py-2 text-right tabular-nums text-gray-900">{formatMoney(l.unitAmount)}</td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr className="border-t border-gray-200">
                        <td className="py-2 pr-4 font-semibold text-gray-900" colSpan={2}>
                          Total, no tax
                        </td>
                        <td className="py-2 text-right font-semibold tabular-nums text-gray-900">{formatMoney(draft.total)}</td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
                {draft.notes.length > 0 && (
                  <ul className="mt-3 space-y-1 text-sm text-amber-900">
                    {draft.notes.map((n, i) => (
                      <li key={i}>{n}</li>
                    ))}
                  </ul>
                )}
                {inXero && (
                  <div className="mt-5 border-t border-gray-100 pt-4">
                    <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-400">As it stands in Xero</p>
                    <ul className="space-y-1 text-sm">
                      {inXero.map((l, i) => (
                        <li key={i} className="flex justify-between gap-4">
                          <span className="text-gray-700">
                            {l.description} <span className="tabular-nums text-gray-500">{l.accountCode ?? ''}</span>
                          </span>
                          <span className="tabular-nums text-gray-900">{formatMoney(l.amount)}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </Card>
            )}
            <div className="space-y-5">
              <Card title="Nippon Express's charges" hint="Everything on the invoice besides CBP's duty and fees.">
                <ul className="divide-y divide-gray-100 text-sm">
                  {serviceChargesOf(pkg.invoice).map((c, i) => (
                    <li key={i} className="flex justify-between gap-4 py-2">
                      <span className="text-gray-700">{chargeLabel(c.label)}</span>
                      <span className="tabular-nums text-gray-900">{formatMoney(c.amount)}</span>
                    </li>
                  ))}
                </ul>
              </Card>

              <Card title="Shipment">
                <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3 xl:grid-cols-2">
                  <Field
                    label="SPOT ID"
                    value={
                      row.spot_id ? (
                        <Link href={`/transport/${row.spot_id}`} className="font-medium text-[#025945] underline underline-offset-2">
                          {row.spot_id}
                        </Link>
                      ) : null
                    }
                  />
                  <Field
                    label="Linked by"
                    value={
                      row.match_method === 'spot'
                        ? 'SPOT ID on the sea waybill'
                        : row.match_method === 'container'
                          ? 'container number'
                          : row.match_method === 'mbl'
                            ? 'master bill of lading'
                            : row.match_method === 'hbl'
                              ? 'house bill of lading'
                              : null
                    }
                  />
                  <Field label="Container" value={pkg.waybill.container_numbers.join(', ')} />
                  <Field label="Master bill" value={pkg.invoice.bl_master} />
                  <Field label="House bill" value={pkg.waybill.hbl ?? pkg.invoice.bl_house} />
                  <Field label="Vessel" value={pkg.invoice.vessel} />
                  <Field label="Arrived" value={formatDate(pkg.invoice.arrival_date)} />
                  <Field label="Delivered to" value={pkg.invoice.delivered_to} />
                  <Field label="Shipper" value={pkg.invoice.shipper} />
                </dl>
              </Card>
            </div>
          </div>

          <Card title="CBP entry summary" hint={pkg.entry ? `Entry ${pkg.entry.entry_number}, entered ${formatDate(pkg.entry.entry_date)} at port ${pkg.entry.port_code ?? '—'}.` : 'No entry summary in this PDF.'}>
            {pkg.entry && check ? (
              <>
                <div className="overflow-x-auto">
                  <table className="min-w-full text-sm">
                    <thead className="text-left text-xs font-semibold uppercase tracking-wide text-gray-500">
                      <tr>
                        <th className="py-2 pr-4">Line</th>
                        <th className="py-2 pr-4">Group invoice</th>
                        <th className="py-2 pr-4 text-right">Entered value</th>
                        <th className="py-2 pr-4">Rates</th>
                        <th className="py-2 text-right">Duty</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      {pkg.entry.lines.map((line, i) => {
                        const recalc = check.lines[i]
                        return (
                          <tr key={line.line_no} className="align-top">
                            <td className="whitespace-nowrap py-2 pr-4 tabular-nums text-gray-700">
                              {line.line_no}
                              {line.origin ? ` · ${line.origin}` : ''}
                            </td>
                            <td className="py-2 pr-4 text-gray-900">{line.invoice_number ?? '—'}</td>
                            <td className="py-2 pr-4 text-right tabular-nums text-gray-900">{formatMoney(line.entered_value)}</td>
                            <td className="py-2 pr-4 text-gray-700">
                              <ul className="space-y-0.5">
                                {line.hts.map((row, j) => (
                                  <li key={j} className="tabular-nums">
                                    {row.code} {row.rate_text ?? (row.rate != null ? pct(row.rate) : '')}
                                  </li>
                                ))}
                              </ul>
                              {recalc?.expected && (
                                <p className="mt-1 text-xs text-gray-500">
                                  Expected {pct(recalc.expected.rate)}: {recalc.expected.basis}
                                </p>
                              )}
                            </td>
                            <td className="py-2 text-right tabular-nums text-gray-900">
                              {formatMoney(recalc?.dutyStated ?? null)}
                              {recalc && <p className="whitespace-nowrap text-xs text-gray-500">{pct(recalc.effectiveRate)} of the value</p>}
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
                <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-3 border-t border-gray-100 pt-4 sm:grid-cols-4">
                  <Field label="Total entered value" value={formatMoney(pkg.entry.total_entered_value)} />
                  <Field label="Duty" value={formatMoney(pkg.entry.duty_total)} />
                  <Field
                    label="Processing fee (0.3464%)"
                    value={
                      <>
                        {formatMoney(pkg.entry.mpf_total)}
                        {check.mpf?.recomputed.clamped && (
                          <span className="block text-xs text-gray-500">
                            the year&apos;s {check.mpf.recomputed.clamped === 'min' ? 'minimum' : 'maximum'}
                          </span>
                        )}
                      </>
                    }
                  />
                  <Field label="Harbor fee (0.125%)" value={formatMoney(pkg.entry.hmf_total)} />
                  <Field label="CBP total" value={<span className="font-semibold">{formatMoney(pkg.entry.total)}</span>} />
                  <Field label="Country of origin" value={pkg.entry.country_of_origin} />
                  <Field label="Manufacturer ID" value={pkg.entry.manufacturer_id} />
                  <Field label="Importer of record" value="Echo Barrier USA LLC" />
                </dl>
              </>
            ) : (
              <p className="text-sm text-gray-600">The duty cannot be checked line by line without it.</p>
            )}
          </Card>

          {pkg.warnings.length > 0 && (
            <Card title="What Claude noticed" hint="Its remarks while reading, for context. They do not change the status; the sums do.">
              <ul className="list-disc space-y-1 pl-5 text-sm text-gray-700">
                {pkg.warnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            </Card>
          )}
        </div>
      )}
    </div>
  )
}
