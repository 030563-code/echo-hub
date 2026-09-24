'use client'
// page-state: none (the durable copy is the transport_shipment_cost row; Save writes every figure at once)

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { saveLocalCosts } from '@/app/actions/transport/landed-cost'
import { formatMoney, type LocalKey, type LocalSource } from '@/lib/transport/landed-cost'
import type { TypedLocal } from '@/lib/transport/landed-cost.server'

/**
 * The customs and delivery costs as Dave's tab has them, typed as a draft while Nippon's invoice is
 * on its way. Once the bill is read, its figures are used wherever it has one, and what was typed
 * stays here as the estimate it was.
 */

type Target = { spotId: string } | { id: string }

const FIELDS: { key: LocalKey; label: string; hint?: string }[] = [
  { key: 'duty', label: 'Duty' },
  { key: 'mpf', label: 'Processing fee (MPF)' },
  { key: 'hmf', label: 'Harbour fee (HMF)' },
  { key: 'disbursement', label: 'Duty disbursement', hint: "Nippon's 3% for paying the duty; the deferment fee on the tab" },
  { key: 'clearance', label: 'Clearance charges', hint: 'Brokerage, forwarding and handling, ISF' },
  { key: 'containerDelivery', label: 'Container delivery', hint: 'From the port to the depot' },
]

const input =
  'mt-1 w-full rounded-lg border border-gray-300 bg-white px-2.5 py-1.5 text-sm focus:border-[#025945] focus:outline-none'

const amount = (s: string) => (s.trim() === '' ? null : Number(s.replace(/,/g, '')))

export default function LandedLocalEditor({
  target,
  currency,
  typed,
  source,
  billTotals,
  onDone,
}: {
  target: Target
  currency: string
  typed: TypedLocal
  source: Record<LocalKey, LocalSource>
  billTotals: Partial<Record<LocalKey, number>>
  onDone: () => void
}) {
  const [values, setValues] = useState<Record<LocalKey, string>>(
    () =>
      Object.fromEntries(
        (['duty', 'mpf', 'hmf', 'disbursement', 'clearance', 'containerDelivery', 'other'] as LocalKey[]).map((k) => [
          k,
          typed.values[k] == null ? '' : String(typed.values[k]),
        ]),
      ) as Record<LocalKey, string>,
  )
  const [otherLabel, setOtherLabel] = useState(typed.otherLabel ?? '')
  const [journalDate, setJournalDate] = useState(typed.journalDate ?? '')
  const [notes, setNotes] = useState(typed.notes ?? '')
  const [pending, startTransition] = useTransition()
  const router = useRouter()

  function save() {
    const costs: Record<string, number | null> = {}
    for (const k of Object.keys(values) as LocalKey[]) {
      const v = amount(values[k])
      if (v != null && !(v >= 0)) {
        toast.error('The amounts are numbers, not below zero.')
        return
      }
      costs[k] = v
    }
    startTransition(async () => {
      try {
        const res = await saveLocalCosts({
          target,
          costs: { ...costs, otherLabel: otherLabel || null, journalDate: journalDate || null, notes: notes || null },
        })
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

  const row = (key: LocalKey, label: string, hint?: string) => (
    <label key={key} className="block">
      <span className="text-xs text-gray-500">
        {label} ({currency})
      </span>
      <input
        inputMode="decimal"
        value={values[key]}
        onChange={(e) => setValues((v) => ({ ...v, [key]: e.target.value }))}
        aria-label={label}
        className={`${input} text-right tabular-nums`}
      />
      {source[key] === 'bill' ? (
        <span className="mt-0.5 block text-xs text-emerald-700">
          Nippon&apos;s bill: {formatMoney(billTotals[key] ?? 0)} is used, not this.
        </span>
      ) : (
        hint && <span className="mt-0.5 block text-xs text-gray-400">{hint}</span>
      )}
    </label>
  )

  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        {FIELDS.map((f) => row(f.key, f.label, f.hint))}
        <label className="block sm:col-span-2">
          <span className="text-xs text-gray-500">Anything else ({currency})</span>
          <div className="flex gap-2">
            <input
              value={otherLabel}
              onChange={(e) => setOtherLabel(e.target.value)}
              placeholder="What for"
              maxLength={80}
              className={`${input} min-w-0 flex-1`}
            />
            <input
              inputMode="decimal"
              value={values.other}
              onChange={(e) => setValues((v) => ({ ...v, other: e.target.value }))}
              aria-label="Other amount"
              className="mt-1 w-28 shrink-0 rounded-lg border border-gray-300 bg-white px-2.5 py-1.5 text-right text-sm tabular-nums focus:border-[#025945] focus:outline-none"
            />
          </div>
        </label>
        <label className="block">
          <span className="text-xs text-gray-500">Booked in Xero on</span>
          <input type="date" value={journalDate} onChange={(e) => setJournalDate(e.target.value)} className={input} />
        </label>
      </div>
      <label className="block">
        <span className="text-xs text-gray-500">Notes</span>
        <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} maxLength={2000} className={input} />
      </label>
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
          {pending ? 'Saving' : 'Save costs'}
        </button>
      </div>
    </div>
  )
}
