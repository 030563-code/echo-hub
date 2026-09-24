'use client'
// page-state: none (the durable copy is the transport_shipment_invoice rows and the lines' amounts;
// Save writes every invoice and every product's amount at once)

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Plus, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { saveLandedInvoices } from '@/app/actions/transport/landed-cost'
import { formatMoney } from '@/lib/transport/landed-cost'
import type { LandedInvoice, LineMoney } from '@/lib/transport/landed-cost.server'
import type { ShipmentLine } from '@/lib/transport/shipment'

/**
 * Group's commercial invoices for the shipment, as Vladimir sends them: the barriers at their
 * price, then palletising, delivery and insurance for the container. In euros, Xero's rate for the
 * bill converts it: "1 USD = 0.85 EUR".
 */

type Target = { spotId: string } | { id: string }

interface InvoiceDraft {
  key: string
  id: string | null
  number: string
  invoiceDate: string
  supplier: string
  currency: string
  rate: string
  palletising: string
  delivery: string
  insurance: string
  otherAmount: string
  otherLabel: string
}

/** What Save sends, one invoice. */
interface InvoicePayload {
  key: string
  id: string | null
  number: string
  invoiceDate: string | null
  supplier: string | null
  currency: string
  rate: number | null
  palletising: number
  delivery: number
  insurance: number
  otherAmount: number
  otherLabel: string | null
}

const CURRENCIES = ['USD', 'EUR', 'GBP', 'CAD']
const DEFAULT_SUPPLIER = 'Echo Barrier Group Limited'

const input =
  'mt-1 w-full rounded-lg border border-gray-300 bg-white px-2.5 py-1.5 text-sm focus:border-[#025945] focus:outline-none'
const amountInput = `${input} text-right tabular-nums`
/** A narrow amount beside its label, in one row: no w-full, which would fight the width. */
const sideAmount =
  'mt-1 w-28 shrink-0 rounded-lg border border-gray-300 bg-white px-2.5 py-1.5 text-right text-sm tabular-nums focus:border-[#025945] focus:outline-none'

let seq = 0
const blank = (currency: string): InvoiceDraft => ({
  key: `new-${++seq}`,
  id: null,
  number: '',
  invoiceDate: '',
  supplier: DEFAULT_SUPPLIER,
  currency,
  rate: '',
  palletising: '',
  delivery: '',
  insurance: '',
  otherAmount: '',
  otherLabel: '',
})

const text = (n: number | null | undefined) => (n == null || n === 0 ? '' : String(n))
/** A typed amount, or null when the box is empty. NaN for anything that is not a number. */
const amount = (s: string) => (s.trim() === '' ? null : Number(s.replace(/,/g, '')))

export default function LandedInvoicesEditor({
  target,
  currency,
  lines,
  invoices,
  money,
  onDone,
}: {
  target: Target
  /** The depot's own currency, which the landed cost is worked in. */
  currency: string
  lines: ShipmentLine[]
  invoices: LandedInvoice[]
  money: LineMoney[]
  onDone: () => void
}) {
  const [drafts, setDrafts] = useState<InvoiceDraft[]>(() =>
    invoices.length
      ? invoices.map((i) => ({
          key: i.id,
          id: i.id,
          number: i.number,
          invoiceDate: i.invoiceDate ?? '',
          supplier: i.supplier ?? '',
          currency: i.currency,
          rate: i.rate == null ? '' : String(i.rate),
          palletising: text(i.palletising),
          delivery: text(i.delivery),
          insurance: text(i.insurance),
          otherAmount: text(i.otherAmount),
          otherLabel: i.otherLabel ?? '',
        }))
      : [blank(currency)],
  )
  const moneyBy = new Map(money.map((m) => [m.lineId, m]))
  const [onInvoice, setOnInvoice] = useState<Record<string, { key: string; amount: string }>>(() =>
    Object.fromEntries(
      lines.map((l) => {
        const m = moneyBy.get(l.id)
        // A lone new invoice is where every product starts.
        const key = m?.invoiceId ?? (invoices.length === 0 && lines.length ? 'first' : '')
        return [l.id, { key, amount: m?.goodsAmount == null ? '' : String(m.goodsAmount) }]
      }),
    ),
  )
  const [pending, startTransition] = useTransition()
  const router = useRouter()

  // The first blank invoice has a key of its own; point "first" at it.
  const firstKey = drafts[0]?.key ?? ''
  const keyOf = (k: string) => (k === 'first' ? firstKey : k)
  const setDraft = (key: string, field: keyof InvoiceDraft, value: string) =>
    setDrafts((ds) => ds.map((d) => (d.key === key ? { ...d, [field]: value } : d)))
  const setLine = (lineId: string, field: 'key' | 'amount', value: string) =>
    setOnInvoice((m) => ({ ...m, [lineId]: { ...m[lineId], [field]: value } }))

  function remove(key: string) {
    setDrafts((ds) => ds.filter((d) => d.key !== key))
    setOnInvoice((m) =>
      Object.fromEntries(Object.entries(m).map(([id, v]) => [id, keyOf(v.key) === key ? { ...v, key: '' } : v])),
    )
  }

  function save() {
    const payloadInvoices: InvoicePayload[] = []
    for (const [i, d] of drafts.entries()) {
      const n = i + 1
      if (!d.number.trim()) return void toast.error(`Invoice ${n} needs its number.`)
      const figures = { palletising: amount(d.palletising), delivery: amount(d.delivery), insurance: amount(d.insurance), otherAmount: amount(d.otherAmount) }
      if (Object.values(figures).some((v) => v != null && !(v >= 0))) return void toast.error(`${d.number}: the amounts are numbers, not below zero.`)
      const rate = d.currency === currency ? null : amount(d.rate)
      if (rate != null && !(rate > 0)) return void toast.error(`${d.number}: the rate is a number above zero.`)
      payloadInvoices.push({
        key: d.key,
        id: d.id,
        number: d.number.trim(),
        invoiceDate: d.invoiceDate || null,
        supplier: d.supplier.trim() || null,
        currency: d.currency,
        rate,
        palletising: figures.palletising ?? 0,
        delivery: figures.delivery ?? 0,
        insurance: figures.insurance ?? 0,
        otherAmount: figures.otherAmount ?? 0,
        otherLabel: d.otherLabel.trim() || null,
      })
    }
    const keys = new Set(drafts.map((d) => d.key))
    const payloadLines: { id: string; invoiceKey: string | null; goodsAmount: number | null }[] = []
    for (const l of lines) {
      const v = onInvoice[l.id] ?? { key: '', amount: '' }
      const key = keys.has(keyOf(v.key)) ? keyOf(v.key) : null
      const goods = amount(v.amount)
      if (goods != null && !(goods >= 0)) return void toast.error(`${l.productCode}: the amount is a number.`)
      payloadLines.push({ id: l.id, invoiceKey: key, goodsAmount: key ? goods : null })
    }
    startTransition(async () => {
      try {
        const res = await saveLandedInvoices({ target, invoices: payloadInvoices, lines: payloadLines })
        if (!res.success) {
          toast.error(res.error)
          return
        }
        toast.success(res.message)
        onDone()
        router.refresh()
      } catch {
        toast.error('That did not go through. Please try again.')
      }
    })
  }

  return (
    <div className="space-y-4">
      {drafts.map((d, i) => (
        <div key={d.key} className="rounded-lg border border-gray-200 p-3">
          <div className="mb-2 flex items-center justify-between">
            <p className="text-sm font-medium text-gray-900">{d.number || `Invoice ${i + 1}`}</p>
            <button
              type="button"
              onClick={() => remove(d.key)}
              aria-label={`Remove ${d.number || `invoice ${i + 1}`}`}
              className="rounded-lg p-1.5 text-gray-400 transition-colors hover:bg-red-50 hover:text-red-600"
            >
              <Trash2 className="h-4 w-4" />
            </button>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block">
              <span className="text-xs text-gray-500">Invoice number</span>
              <input
                value={d.number}
                onChange={(e) => setDraft(d.key, 'number', e.target.value)}
                aria-label={`Invoice ${i + 1} number`}
                placeholder="EBGS..."
                maxLength={40}
                className={`${input} uppercase`}
              />
            </label>
            <label className="block">
              <span className="text-xs text-gray-500">Date</span>
              <input type="date" value={d.invoiceDate} onChange={(e) => setDraft(d.key, 'invoiceDate', e.target.value)} className={input} />
            </label>
            <label className="block">
              <span className="text-xs text-gray-500">Currency</span>
              <select
                value={d.currency}
                onChange={(e) => setDraft(d.key, 'currency', e.target.value)}
                aria-label={`Invoice ${i + 1} currency`}
                className={input}
              >
                {CURRENCIES.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </label>
            {d.currency !== currency ? (
              <label className="block">
                <span className="text-xs text-gray-500">
                  Xero&apos;s rate: 1 {currency} = ? {d.currency}
                </span>
                <input
                  inputMode="decimal"
                  value={d.rate}
                  onChange={(e) => setDraft(d.key, 'rate', e.target.value)}
                  aria-label={`Invoice ${i + 1} rate`}
                  placeholder="0.85"
                  className={amountInput}
                />
              </label>
            ) : (
              <div />
            )}
            {(
              [
                ['palletising', 'Palletising'],
                ['delivery', 'Delivery'],
                ['insurance', 'Insurance'],
              ] as const
            ).map(([field, label]) => (
              <label key={field} className="block">
                <span className="text-xs text-gray-500">
                  {label} ({d.currency})
                </span>
                <input
                  inputMode="decimal"
                  value={d[field]}
                  onChange={(e) => setDraft(d.key, field, e.target.value)}
                  aria-label={`Invoice ${i + 1} ${label.toLowerCase()}`}
                  className={amountInput}
                />
              </label>
            ))}
            <label className="block sm:col-span-2">
              <span className="text-xs text-gray-500">Anything else on it ({d.currency})</span>
              <div className="flex gap-2">
                <input
                  value={d.otherLabel}
                  onChange={(e) => setDraft(d.key, 'otherLabel', e.target.value)}
                  placeholder="What for"
                  maxLength={80}
                  className={`${input} min-w-0 flex-1`}
                />
                <input
                  inputMode="decimal"
                  value={d.otherAmount}
                  onChange={(e) => setDraft(d.key, 'otherAmount', e.target.value)}
                  aria-label={`Invoice ${i + 1} other amount`}
                  className={sideAmount}
                />
              </div>
            </label>
          </div>
        </div>
      ))}

      <button
        type="button"
        onClick={() => setDrafts((ds) => [...ds, blank(currency)])}
        className="inline-flex items-center gap-1.5 rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50"
      >
        <Plus className="h-3.5 w-3.5" /> Another invoice
      </button>

      <div>
        <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-400">The barriers on each invoice</p>
        <div className="space-y-2">
          {lines.map((l) => {
            const v = onInvoice[l.id] ?? { key: '', amount: '' }
            const chosen = drafts.find((d) => d.key === keyOf(v.key))
            const typed = amount(v.amount)
            return (
              <div key={l.id} className="grid items-end gap-2 sm:grid-cols-[1fr_1fr_1fr]">
                <p className="text-sm text-gray-900">
                  <span className="font-medium">{l.productCode}</span>
                  <span className="text-gray-500"> · {l.quantity.toLocaleString('en-US')}</span>
                </p>
                <label className="block">
                  <span className="text-xs text-gray-500">On invoice</span>
                  <select
                    value={chosen ? chosen.key : ''}
                    onChange={(e) => setLine(l.id, 'key', e.target.value)}
                    aria-label={`${l.productCode} invoice`}
                    className={input}
                  >
                    <option value="">Not on one yet</option>
                    {drafts.map((d, i) => (
                      <option key={d.key} value={d.key}>
                        {d.number || `Invoice ${i + 1}`}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="block">
                  <span className="text-xs text-gray-500">Amount on it{chosen ? ` (${chosen.currency})` : ''}</span>
                  <input
                    inputMode="decimal"
                    value={v.amount}
                    disabled={!chosen}
                    onChange={(e) => setLine(l.id, 'amount', e.target.value)}
                    aria-label={`${l.productCode} amount`}
                    className={`${amountInput} disabled:bg-gray-50`}
                  />
                  {chosen && typed != null && typed > 0 && l.quantity > 0 && (
                    <span className="mt-0.5 block text-right text-xs text-gray-400 tabular-nums">
                      {formatMoney(typed / l.quantity)} each
                    </span>
                  )}
                </label>
              </div>
            )
          })}
        </div>
      </div>

      <div className="flex items-center justify-end gap-2">
        <button type="button" onClick={onDone} disabled={pending} className="px-3 py-1.5 text-sm text-gray-500 hover:text-gray-800">
          Cancel
        </button>
        <button
          type="button"
          onClick={save}
          disabled={pending}
          className="rounded-lg bg-[#025945] px-4 py-1.5 text-sm font-medium text-white transition-colors hover:bg-[#03674f] disabled:opacity-60"
        >
          {pending ? 'Saving' : 'Save invoices'}
        </button>
      </div>
    </div>
  )
}
