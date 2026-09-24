'use client'
// page-state: none (only which editor is open; each editor saves its figures to the database)

import { useState } from 'react'
import Link from 'next/link'
import { Pencil, Receipt } from 'lucide-react'
import { PARTS, formatMoney as money, formatUnit as unit, type LocalKey } from '@/lib/transport/landed-cost'
import type { LandedView } from '@/lib/transport/landed-cost.server'
import type { ShipmentLine } from '@/lib/transport/shipment'
import LandedInvoicesEditor from './landed-invoices-editor'
import LandedLocalEditor from './landed-local-editor'

/**
 * What each barrier on this shipment cost to land, laid out the way Dave's tab is: one column per
 * product, one row per cost, the total, then the unit cost that goes on the PO.
 *
 * Dean, 24 Sep 2026: "He then takes all the invoice barrier costs+ delivery cost +palletsing +
 * insurance + duty + clearance etc. and then divides it by the number of barriers to get the unit
 * cost per barrier."
 */

type Target = { spotId: string } | { id: string }

const LOCAL_LABEL: Record<LocalKey, string> = {
  duty: 'Duty',
  mpf: 'Processing fee (MPF)',
  hmf: 'Harbour fee (HMF)',
  disbursement: 'Duty disbursement',
  clearance: 'Clearance charges',
  containerDelivery: 'Container delivery',
  other: 'Other',
}

function status(view: LandedView, lines: ShipmentLine[]): { label: string; tone: string } {
  if (!lines.length) return { label: 'Needs its contents first', tone: 'bg-gray-100 text-gray-600' }
  if (view.result.missing.length) return { label: 'Waiting for figures', tone: 'bg-amber-50 text-amber-800' }
  const sources = Object.values(view.source)
  if (!sources.some(Boolean)) return { label: 'No customs costs yet', tone: 'bg-amber-50 text-amber-800' }
  if (!view.bills.length) return { label: 'Draft: customs typed by hand', tone: 'bg-blue-50 text-blue-800' }
  return { label: "From the invoices and Nippon's bill", tone: 'bg-emerald-50 text-emerald-800' }
}

export default function LandedCostCard({
  target,
  lines,
  view,
}: {
  target: Target
  lines: ShipmentLine[]
  view: LandedView
}) {
  const [editing, setEditing] = useState<'none' | 'invoices' | 'local'>('none')
  const { result, currency } = view
  const chip = status(view, lines)
  // Only the costs something was charged for, and the barriers always.
  const rows = PARTS.filter((p) => p.key === 'goods' || result.totals[p.key] !== 0)
  const invoiceOf = new Map(view.money.map((m) => [m.lineId, m]))

  return (
    <section className="mt-5 rounded-xl border border-gray-200 bg-white p-5">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-gray-900" style={{ fontFamily: 'Varela Round, sans-serif' }}>
            Landed cost
          </h2>
          <p className="mt-0.5 text-sm text-gray-500">
            What each barrier cost to land, in {currency}, worked the way Dave&apos;s tab does.
          </p>
        </div>
        <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${chip.tone}`}>{chip.label}</span>
      </div>

      {lines.length === 0 ? (
        <p className="text-sm text-gray-500">List what is on the shipment above, then its costs can be worked out here.</p>
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[520px] text-sm">
              <thead>
                <tr className="border-b border-gray-100 text-xs text-gray-500">
                  <th className="sticky left-0 bg-white py-2 pr-4 text-left font-medium" />
                  {result.lines.map((l) => (
                    <th key={l.lineId} className="py-2 pr-4 text-right font-medium">
                      <span className="block font-semibold text-gray-900">{l.productCode}</span>
                      <span className="tabular-nums">
                        {l.quantity.toLocaleString('en-US')}
                        {l.pallets != null ? ` on ${l.pallets.toLocaleString('en-US')} pallets` : ''}
                      </span>
                    </th>
                  ))}
                  {result.lines.length > 1 && <th className="py-2 text-right font-medium">Shipment</th>}
                </tr>
              </thead>
              <tbody className="tabular-nums">
                {rows.map((p) => (
                  <tr key={p.key} className="border-b border-gray-50">
                    <td className="sticky left-0 bg-white py-1.5 pr-4 text-gray-600">{p.label}</td>
                    {result.lines.map((l) => (
                      <td key={l.lineId} className="py-1.5 pr-4 text-right text-gray-900">
                        {money(l.parts[p.key])}
                      </td>
                    ))}
                    {result.lines.length > 1 && <td className="py-1.5 text-right text-gray-700">{money(result.totals[p.key])}</td>}
                  </tr>
                ))}
                <tr className="border-t border-gray-200 font-semibold">
                  <td className="sticky left-0 bg-white py-2 pr-4 text-gray-900">Total</td>
                  {result.lines.map((l) => (
                    <td key={l.lineId} className="py-2 pr-4 text-right text-gray-900">
                      {money(l.total)}
                    </td>
                  ))}
                  {result.lines.length > 1 && <td className="py-2 text-right text-gray-900">{money(result.total)}</td>}
                </tr>
                <tr className="bg-[#025945]/5">
                  <td className="sticky left-0 bg-[#f2f7f6] py-2 pr-4 font-semibold text-[#025945]">Cost per barrier</td>
                  {result.lines.map((l) => (
                    <td key={l.lineId} className="py-2 pr-4 text-right text-base font-bold text-[#025945]">
                      {l.xeroUnit == null ? '—' : unit(l.xeroUnit)}
                    </td>
                  ))}
                  {result.lines.length > 1 && <td />}
                </tr>
              </tbody>
            </table>
          </div>
          {result.lines.some((l) => l.xeroAmount != null && Math.abs(l.xeroAmount - l.total) >= 0.01) && (
            <p className="mt-2 text-xs text-gray-500">
              A PO line carries the cost to four decimals, so{' '}
              {result.lines
                .filter((l) => l.xeroAmount != null && Math.abs(l.xeroAmount - l.total) >= 0.01)
                .map((l) => `${l.productCode} comes to ${money(l.xeroAmount!)} on it against ${money(l.total)} here`)
                .join('; ')}
              .
            </p>
          )}

          {result.missing.length > 0 && (
            <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
              <p className="font-medium">Still needed before the cost per barrier is final:</p>
              <ul className="mt-1 list-disc pl-5">
                {result.missing.map((m) => (
                  <li key={m}>{m}</li>
                ))}
              </ul>
            </div>
          )}
          {[...result.notes, ...view.billNotes].length > 0 && (
            <ul className="mt-3 space-y-1 text-xs text-gray-500">
              {[...result.notes, ...view.billNotes].map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          )}
        </>
      )}

      <div className="mt-5 grid gap-5 lg:grid-cols-2">
        <div className={`rounded-lg border border-gray-100 p-4 ${editing === 'invoices' ? 'lg:col-span-2' : ''}`}>
          <div className="mb-2 flex items-center justify-between gap-2">
            <p className="text-xs font-semibold uppercase tracking-wide text-gray-400">Commercial invoices</p>
            {editing !== 'invoices' && lines.length > 0 && (
              <button
                type="button"
                onClick={() => setEditing('invoices')}
                aria-label={view.invoices.length ? 'Edit the commercial invoices' : 'Add a commercial invoice'}
                className="inline-flex items-center gap-1 text-sm font-medium text-[#025945] hover:underline"
              >
                <Pencil className="h-3.5 w-3.5" /> {view.invoices.length ? 'Edit' : 'Add'}
              </button>
            )}
          </div>
          {editing === 'invoices' ? (
            <LandedInvoicesEditor
              target={target}
              currency={currency}
              lines={lines}
              invoices={view.invoices}
              money={view.money}
              onDone={() => setEditing('none')}
            />
          ) : view.invoices.length === 0 ? (
            <p className="text-sm text-gray-500">None yet. Add Group&apos;s invoice to put the barrier cost, palletising, delivery and insurance in.</p>
          ) : (
            <ul className="space-y-3">
              {view.invoices.map((inv) => {
                const on = lines.filter((l) => invoiceOf.get(l.id)?.invoiceId === inv.id)
                return (
                  <li key={inv.id} className="text-sm">
                    <p className="font-medium text-gray-900">
                      {inv.number}
                      <span className="font-normal text-gray-500">
                        {inv.invoiceDate ? ` · ${inv.invoiceDate}` : ''} · {inv.currency}
                        {inv.currency !== currency && (inv.rate ? ` at 1 ${currency} = ${inv.rate} ${inv.currency}` : ', no rate yet')}
                      </span>
                    </p>
                    <p className="text-gray-600">
                      {[
                        ...on.map((l) => {
                          const amount = invoiceOf.get(l.id)?.goodsAmount
                          return `${l.productCode} ${amount == null ? 'amount missing' : `${inv.currency} ${money(amount)}`}`
                        }),
                        inv.palletising ? `palletising ${money(inv.palletising)}` : null,
                        inv.delivery ? `delivery ${money(inv.delivery)}` : null,
                        inv.insurance ? `insurance ${money(inv.insurance)}` : null,
                        inv.otherAmount ? `${inv.otherLabel ?? 'other'} ${money(inv.otherAmount)}` : null,
                      ]
                        .filter(Boolean)
                        .join(' · ') || 'Nothing on it yet'}
                    </p>
                  </li>
                )
              })}
            </ul>
          )}
        </div>

        <div className={`rounded-lg border border-gray-100 p-4 ${editing === 'local' ? 'lg:col-span-2' : ''}`}>
          <div className="mb-2 flex items-center justify-between gap-2">
            <p className="text-xs font-semibold uppercase tracking-wide text-gray-400">Customs and delivery</p>
            {editing !== 'local' && (
              <button
                type="button"
                onClick={() => setEditing('local')}
                aria-label="Edit the customs and delivery costs"
                className="inline-flex items-center gap-1 text-sm font-medium text-[#025945] hover:underline"
              >
                <Pencil className="h-3.5 w-3.5" /> Edit
              </button>
            )}
          </div>
          {editing === 'local' ? (
            <LandedLocalEditor
              target={target}
              currency={currency}
              typed={view.typed}
              source={view.source}
              billTotals={view.billTotals}
              onDone={() => setEditing('none')}
            />
          ) : (
            <>
              {view.bills.length > 0 ? (
                <p className="mb-2 flex flex-wrap items-center gap-1 text-sm text-gray-600">
                  <Receipt className="h-3.5 w-3.5 text-[#025945]" /> From Nippon&apos;s bill
                  {view.bills.length > 1 ? 's' : ''}{' '}
                  {view.bills.map((b, i) => (
                    <span key={b.id}>
                      {i > 0 ? ', ' : ''}
                      <Link href={`/transport/customs/${b.id}`} className="font-medium text-[#025945] hover:underline">
                        {b.invoiceNumber ?? 'unnumbered'}
                      </Link>
                    </span>
                  ))}
                  , and typed where it has no figure.
                </p>
              ) : (
                <p className="mb-2 text-sm text-gray-600">Typed by hand until Nippon&apos;s bill for this shipment is read.</p>
              )}
              <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
                {(Object.keys(LOCAL_LABEL) as LocalKey[])
                  .filter((k) => view.source[k])
                  .map((k) => {
                    const total = view.source[k] === 'bill' ? (view.billTotals[k] ?? 0) : (view.typed.values[k] ?? 0)
                    return (
                      <div key={k} className="contents">
                        <dt className="text-gray-600">
                          {k === 'other' && view.typed.otherLabel ? view.typed.otherLabel : LOCAL_LABEL[k]}
                        </dt>
                        <dd className="text-right tabular-nums text-gray-900">
                          {money(total)}{' '}
                          <span className="text-xs text-gray-400">{view.source[k] === 'bill' ? 'bill' : 'typed'}</span>
                        </dd>
                      </div>
                    )
                  })}
              </dl>
              {!Object.values(view.source).some(Boolean) && <p className="text-sm text-gray-500">Nothing yet.</p>}
              {view.typed.journalDate && (
                <p className="mt-2 text-xs text-gray-500">Booked in Xero on {view.typed.journalDate}.</p>
              )}
            </>
          )}
        </div>
      </div>
    </section>
  )
}
