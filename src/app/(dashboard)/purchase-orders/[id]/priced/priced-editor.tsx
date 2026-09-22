'use client'

// page-state: none (the document is saved to the ORDER, in po_priced_document, not to this
// person's page state. Two people editing one order must not each carry their own private copy
// of what Bamida is going to be paid.)

import { useState, useTransition } from 'react'
import { toast } from 'sonner'
import { useRouter } from 'next/navigation'
import { Loader2, Plus, Trash2, RotateCcw, Save, CheckCircle2, FileDown } from 'lucide-react'
import {
  savePricedDocument,
  confirmPricedDocument,
  resetPricedDocument,
  type PricedEditorState,
} from '@/app/actions/purchase-orders/priced-document'
import { downloadSupplierPoPdf } from '@/app/actions/purchase-orders/download-supplier-po'
import { saveFactoryPdf } from '@/lib/factory/save-pdf'
import { confirmButton } from '@/lib/po-spec-draft'
import { pricedDriftSentence, pricedTotals, type PricedDraft, type PricedDraftLine } from '@/lib/po-priced-draft'

/**
 * The priced order as a form: one row per line, every cell editable, totals worked out live
 * with the same arithmetic the printer uses.
 *
 * NOTHING SAVES BY ITSELF. Every change sits in the browser until Save or Confirm is pressed.
 * Confirm writes the document AND signs it, because the commonest case is a generated document
 * that is already correct and must not need a pointless edit before it can be signed.
 */

const input =
  'w-full rounded-md border border-gray-300 px-2.5 py-1.5 text-sm focus:border-[#025945] focus:outline-none focus:ring-1 focus:ring-[#025945] disabled:bg-gray-50 disabled:text-gray-600'
const ghost =
  'inline-flex items-center gap-1.5 rounded-md border border-gray-300 bg-white px-2.5 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50'

const eur = (v: number) => new Intl.NumberFormat('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(v)
const iso = (value: string | null) => (value ? value.slice(0, 10) : null)
const blank = (): PricedDraftLine => ({ code: '', description: '', qty: 1, unit: 'EA', price: 0, taxRate: 0 })

export default function PricedEditor({ poId, initial }: { poId: string; initial: PricedEditorState }) {
  const router = useRouter()
  const [draft, setDraft] = useState<PricedDraft>(initial.draft)
  const [dirty, setDirty] = useState(false)
  const [state, setState] = useState(initial)
  const [pending, start] = useTransition()
  const [downloading, setDownloading] = useState(false)

  const readOnly = !state.canEdit
  const signOff = confirmButton({ confirmedAt: state.confirmedAt, dirty, pending })
  const totals = pricedTotals(draft)

  /** Every edit goes through here, so nothing can change the draft without marking it unsaved. */
  const edit = (lines: PricedDraftLine[]) => {
    setDraft({ lines })
    setDirty(true)
  }
  const editLine = (index: number, patch: Partial<PricedDraftLine>) =>
    edit(draft.lines.map((l, i) => (i === index ? { ...l, ...patch } : l)))
  const number = (v: string) => {
    const n = Number(v)
    return Number.isFinite(n) && n >= 0 ? n : 0
  }

  /** Every write returns the new state, so the screen shows the database and not a guess. */
  function apply(result: Awaited<ReturnType<typeof savePricedDocument>>, done: string) {
    if (!result.ok) {
      toast.error(result.error)
      return
    }
    setState(result.state)
    setDraft(result.state.draft)
    setDirty(false)
    toast.success(done)
    router.refresh()
  }

  function save() {
    start(async () => apply(await savePricedDocument({ poId, draft }), 'Saved to the order'))
  }
  function confirm() {
    start(async () => apply(await confirmPricedDocument({ poId, draft }), 'Priced order confirmed'))
  }
  function reset() {
    if (
      !window.confirm(
        'Rebuild this priced order from the bill of materials and the specification? Every change made here, and any confirmation, is lost.',
      )
    )
      return
    start(async () => apply(await resetPricedDocument({ poId }), 'Rebuilt from the order'))
  }
  async function download() {
    setDownloading(true)
    try {
      const res = await downloadSupplierPoPdf({ poId, kind: 'priced' })
      if (!res.ok) throw new Error(res.error)
      saveFactoryPdf(res)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not build the PDF')
    } finally {
      setDownloading(false)
    }
  }

  return (
    <div className="mt-6 space-y-5 pb-28">
      {/* ------------------------------------------------------------ status */}
      <section
        className={`rounded-lg border px-4 py-3 text-sm ${
          state.confirmedAt ? 'border-emerald-200 bg-emerald-50 text-emerald-900' : 'border-amber-200 bg-amber-50 text-amber-900'
        }`}
      >
        {state.confirmedAt ? (
          <p className="flex items-start gap-2">
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              Confirmed by {state.confirmedBy ?? 'someone'} on {iso(state.confirmedAt)}. The PDF prints
              exactly these lines. Changing anything here withdraws the confirmation, so it always
              belongs to the lines that were read.
            </span>
          </p>
        ) : (
          <p>
            <strong>Not confirmed.</strong>{' '}
            {state.saved
              ? `Saved${state.updatedBy ? ` by ${state.updatedBy}` : ''}${iso(state.updatedAt) ? ` on ${iso(state.updatedAt)}` : ''}, and the PDF prints these lines, but nobody has signed them off.`
              : 'Generated from the bill of materials and the specification; nothing has been saved for this order yet. If it is already right, press Confirm priced order: that saves it and signs it in one go.'}
          </p>
        )}
      </section>

      {/* -------------------------------------------------------- order drift */}
      {state.drift.length > 0 && (
        <section className="rounded-lg border border-orange-200 bg-orange-50 px-4 py-3 text-sm text-orange-900">
          <p className="font-medium">This document and the order no longer agree.</p>
          <ul className="mt-1.5 list-disc space-y-0.5 pl-5">
            {state.drift.map((d, i) => (
              <li key={i}>{pricedDriftSentence(d)}</li>
            ))}
          </ul>
          <p className="mt-2 text-xs">
            Nothing was changed for you. Edit the lines below, or rebuild from the order, which
            replaces everything here.
          </p>
        </section>
      )}

      {/* --------------------------------------------------------------- lines */}
      <section className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
        <table className="w-full min-w-[820px] text-sm">
          <thead>
            <tr className="border-b border-gray-200 bg-gray-50 text-left text-[11px] font-medium uppercase tracking-wide text-gray-500">
              <th className="px-3 py-2">Code</th>
              <th className="px-3 py-2">Description</th>
              <th className="px-3 py-2 text-right">Qty</th>
              <th className="px-3 py-2">Unit</th>
              <th className="px-3 py-2 text-right">Unit price EUR</th>
              <th className="px-3 py-2 text-right">Tax %</th>
              <th className="px-3 py-2 text-right">Amount EUR</th>
              <th className="px-1 py-2" aria-label="Remove" />
            </tr>
          </thead>
          <tbody>
            {draft.lines.length === 0 && (
              <tr>
                <td colSpan={8} className="px-3 py-4 text-xs italic text-gray-400">
                  No lines. Add one, or rebuild from the order.
                </td>
              </tr>
            )}
            {draft.lines.map((l, i) => (
              <tr key={i} className="border-b border-gray-100 align-top last:border-0">
                <td className="w-40 px-2 py-1.5">
                  <input className={`${input} font-mono`} value={l.code} disabled={readOnly} onChange={(e) => editLine(i, { code: e.target.value })} />
                </td>
                <td className="px-2 py-1.5">
                  <input className={input} value={l.description} disabled={readOnly} onChange={(e) => editLine(i, { description: e.target.value })} />
                </td>
                <td className="w-24 px-2 py-1.5">
                  <input className={`${input} text-right`} type="number" min={0} step={1} value={l.qty} disabled={readOnly} onChange={(e) => editLine(i, { qty: Math.round(number(e.target.value)) })} />
                </td>
                <td className="w-20 px-2 py-1.5">
                  <input className={input} value={l.unit} disabled={readOnly} onChange={(e) => editLine(i, { unit: e.target.value })} />
                </td>
                <td className="w-32 px-2 py-1.5">
                  <input className={`${input} text-right`} type="number" min={0} step={0.01} value={l.price} disabled={readOnly} onChange={(e) => editLine(i, { price: number(e.target.value) })} />
                </td>
                <td className="w-24 px-2 py-1.5">
                  <input className={`${input} text-right`} type="number" min={0} max={100} step={0.5} value={l.taxRate} disabled={readOnly} onChange={(e) => editLine(i, { taxRate: Math.min(100, number(e.target.value)) })} />
                </td>
                <td className="w-32 px-3 py-2.5 text-right tabular-nums text-gray-900">{eur(Math.round(l.qty * l.price * 100) / 100)}</td>
                <td className="w-10 px-1 py-1.5">
                  {!readOnly && (
                    <button
                      type="button"
                      onClick={() => edit(draft.lines.filter((_, j) => j !== i))}
                      title="Remove this line"
                      aria-label="Remove this line"
                      className="inline-flex h-8 w-8 items-center justify-center rounded-md text-gray-400 hover:bg-red-50 hover:text-red-600"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot className="border-t border-gray-200 bg-gray-50 text-sm">
            <tr>
              <td colSpan={6} className="px-3 py-2 text-right text-gray-600">Subtotal</td>
              <td className="px-3 py-2 text-right tabular-nums text-gray-900">{eur(totals.subtotal)}</td>
              <td />
            </tr>
            <tr>
              <td colSpan={6} className="px-3 py-1 text-right text-gray-600">Tax</td>
              <td className="px-3 py-1 text-right tabular-nums text-gray-900">{eur(totals.tax)}</td>
              <td />
            </tr>
            <tr>
              <td colSpan={6} className="px-3 py-2 text-right font-semibold text-gray-900">Total incl. tax (EUR)</td>
              <td className="px-3 py-2 text-right font-semibold tabular-nums text-gray-900">{eur(totals.total)}</td>
              <td />
            </tr>
          </tfoot>
        </table>
        {!readOnly && (
          <div className="border-t border-gray-100 px-3 py-2.5">
            <button type="button" onClick={() => edit([...draft.lines, blank()])} className={ghost}>
              <Plus className="h-3.5 w-3.5" />
              Add line
            </button>
            <span className="ml-3 text-xs text-gray-500">Transport, a one-off item, a discount as a negative price is not allowed: use a line with the agreed lower price.</span>
          </div>
        )}
      </section>

      {/* ------------------------------------------------------------ actions */}
      <div className="fixed inset-x-0 bottom-0 z-10 border-t border-gray-200 bg-white/95 px-4 py-3 backdrop-blur sm:px-6">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-2">
          {readOnly ? (
            <p className="text-sm text-gray-600">You can read this priced order. Changing it needs the bill of materials capability.</p>
          ) : (
            <>
              <button
                onClick={save}
                disabled={pending || !dirty}
                className="inline-flex items-center gap-2 rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
              >
                {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                {dirty ? 'Save without confirming' : 'Saved'}
              </button>
              <button
                onClick={confirm}
                disabled={signOff.disabled}
                title={signOff.title}
                className="inline-flex items-center gap-2 rounded-lg bg-[#025945] px-4 py-2 text-sm font-medium text-white hover:bg-[#03674f] disabled:opacity-50"
              >
                {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
                {signOff.label.replace('specification', 'priced order')}
              </button>
              <button onClick={reset} disabled={pending} className={ghost}>
                <RotateCcw className="h-3.5 w-3.5" />
                Rebuild from the order
              </button>
            </>
          )}
          <button onClick={download} disabled={downloading} className={`${ghost} ml-auto`}>
            {downloading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FileDown className="h-3.5 w-3.5" />}
            {dirty ? 'Download last saved (PDF)' : 'Download PDF'}
          </button>
        </div>
      </div>
    </div>
  )
}
