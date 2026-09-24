'use client'

// page-state: none (the two dates are saved by an explicit button and the three
// steps derive from the row, so there is no draft worth keeping)

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { CheckCircle2, Download, Paperclip } from 'lucide-react'
import {
  confirmFactoryOrder,
  downloadFactoryOrderPdf,
  downloadFactoryPricedOrderPdf,
  getFactoryDocumentUrl,
  markFactoryFinished,
  saveFactoryDates,
} from '@/app/actions/factory/orders'
import type { FactoryDocument } from '@/lib/factory/orders'
import { DATES_REQUIRED_TO_CONFIRM } from '@/lib/factory/status'
import { factoryDate, fill, strings, type FactoryLocale } from '@/lib/factory/strings'
import { saveFactoryPdf } from '@/lib/factory/save-pdf'

/**
 * The three steps, in the order Dean set out on 16 Sep 2026: download the
 * purchase order, confirm it with both estimated dates, and press Manufacturing
 * finished once the whole order is manufactured and packed.
 *
 * Numbered because the order matters and the third one cannot be undone: it
 * tells us the barriers are ready so we can arrange the collection. The card
 * used to say we could only pay their invoice once it was pressed. That was
 * never true, the factory called it out, and it must not come back.
 *
 * Every refusal here is also enforced server-side. The disabled Confirm button
 * is a courtesy; the action refuses without both dates whatever the browser
 * sends.
 */
export function OrderSteps({
  poId,
  poNumber,
  estStart,
  estFinish,
  confirmedAt,
  finishedAt,
  documents,
  locale,
}: {
  poId: string
  poNumber: string
  estStart: string | null
  estFinish: string | null
  confirmedAt: string | null
  finishedAt: string | null
  documents: FactoryDocument[]
  locale: FactoryLocale
}) {
  const t = strings(locale)
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [start, setStart] = useState(estStart ?? '')
  const [finish, setFinish] = useState(estFinish ?? '')
  const [confirming, setConfirming] = useState(false)
  const [blocked, setBlocked] = useState<{ url: string; filename: string } | null>(null)
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)

  const bothDates = start !== '' && finish !== ''
  // The dates are welcome, not demanded. DATES_REQUIRED_TO_CONFIRM in
  // status.ts carries the reasoning and turns it back on in one line.
  const datesBlockConfirm = DATES_REQUIRED_TO_CONFIRM && !bothDates
  const isConfirmed = Boolean(confirmedAt)
  const isFinished = Boolean(finishedAt)

  // Two documents, one download path. The specification is what the floor
  // builds from; the priced order is the same order for their accounts (Dean,
  // 18 Sep 2026, after the factory asked for prices).
  function download(action: typeof downloadFactoryOrderPdf) {
    setMessage(null)
    startTransition(async () => {
      const res = await action({ poId })
      if (!res.ok) {
        setMessage({ kind: 'error', text: res.error })
        return
      }
      saveFactoryPdf(res)
    })
  }

  function saveDates() {
    setMessage(null)
    startTransition(async () => {
      const res = await saveFactoryDates({
        poId,
        estStart: start === '' ? null : start,
        estFinish: finish === '' ? null : finish,
      })
      setMessage(res.ok ? { kind: 'ok', text: t.datesSaved } : { kind: 'error', text: res.error })
      if (res.ok) router.refresh()
    })
  }

  function confirm() {
    setMessage(null)
    startTransition(async () => {
      const res = await confirmFactoryOrder({
        poId,
        estStart: start === '' ? null : start,
        estFinish: finish === '' ? null : finish,
      })
      if (!res.ok) setMessage({ kind: 'error', text: res.error })
      router.refresh()
    })
  }

  function openDocument(attachmentId: string) {
    setMessage(null)
    setBlocked(null)
    // Opened synchronously and filled in after, because a tab opened later is
    // the one Safari blocks.
    const tab = window.open('', '_blank')
    startTransition(async () => {
      const res = await getFactoryDocumentUrl({ poId, attachmentId })
      if (!res.ok) {
        tab?.close()
        setMessage({ kind: 'error', text: res.error })
        return
      }
      if (tab) {
        tab.location.href = res.url
        return
      }
      // Both the placeholder tab and this one come back null when popups are
      // blocked, and neither throws. Without this the button would look broken.
      const opened = window.open(res.url, '_blank')
      if (!opened) setBlocked({ url: res.url, filename: res.filename })
    })
  }

  function finished() {
    setConfirming(false)
    setMessage(null)
    startTransition(async () => {
      const res = await markFactoryFinished({ poId })
      if (!res.ok) setMessage({ kind: 'error', text: res.error })
      router.refresh()
    })
  }

  return (
    <div className="mt-8 space-y-4">
      <Step number={1} title={t.step1Title} done={false}>
        <p className="text-sm text-gray-600">{fill(t.step1Body, { number: poNumber })}</p>
        <div className="mt-4 flex flex-wrap gap-2">
          <button
            onClick={() => download(downloadFactoryOrderPdf)}
            disabled={pending}
            className="inline-flex items-center gap-2 rounded-lg border border-gray-300 bg-white px-5 py-2 text-sm font-medium text-gray-900 transition-colors hover:bg-gray-50 disabled:opacity-50"
          >
            <Download className="h-4 w-4" />
            {t.step1Button}
          </button>
          <button
            onClick={() => download(downloadFactoryPricedOrderPdf)}
            disabled={pending}
            className="inline-flex items-center gap-2 rounded-lg border border-gray-300 bg-white px-5 py-2 text-sm font-medium text-gray-900 transition-colors hover:bg-gray-50 disabled:opacity-50"
          >
            <Download className="h-4 w-4" />
            {t.step1PricedButton}
          </button>
        </div>
        <p className="mt-2 text-xs text-gray-500">{t.step1PricedHint}</p>

        {documents.length > 0 && (
          <div className="mt-5 border-t border-gray-100 pt-4">
            <h3 className="text-sm font-semibold text-gray-900">{t.step1Files}</h3>
            <p className="mt-1 text-xs text-gray-500">{t.step1FilesHint}</p>
            <ul className="mt-3 space-y-1.5">
              {documents.map((d) => (
                <li key={d.id}>
                  <button
                    onClick={() => openDocument(d.id)}
                    disabled={pending}
                    className="inline-flex items-center gap-2 rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm text-gray-900 transition-colors hover:bg-gray-50 disabled:opacity-50"
                  >
                    <Paperclip className="h-3.5 w-3.5 text-gray-500" />
                    {d.filename}
                  </button>
                </li>
              ))}
            </ul>
            {blocked && (
              <p className="mt-3 text-sm text-amber-900">
                <a
                  href={blocked.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-medium text-echo-orange underline hover:no-underline"
                >
                  {fill(t.step1FilesBlocked, { name: blocked.filename })}
                </a>
              </p>
            )}
          </div>
        )}
      </Step>

      <Step number={2} title={t.step2Title} done={isConfirmed}>
        {isConfirmed ? (
          <>
            <p className="text-sm text-emerald-900">
              {fill(t.step2Confirmed, {
                date: factoryDate(confirmedAt, locale, { day: 'numeric', month: 'short', year: 'numeric' }),
              })}
            </p>
            <p className="mt-3 text-sm text-gray-600">{t.step2StillEditable}</p>
          </>
        ) : (
          <p className="text-sm text-gray-600">{t.step2Body}</p>
        )}

        {!isFinished && (
          <>
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <label className="block">
                <span className="text-xs font-medium uppercase tracking-wider text-gray-500">
                  {t.labelEstimatedStart} {isConfirmed ? '' : t.optional}
                </span>
                <input
                  type="date"
                  value={start}
                  onChange={(e) => setStart(e.target.value)}
                  className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-900 transition-colors focus:border-echo-orange focus:outline-none focus:ring-1 focus:ring-echo-orange"
                />
              </label>
              <label className="block">
                <span className="text-xs font-medium uppercase tracking-wider text-gray-500">
                  {t.labelEstimatedFinish} {isConfirmed ? '' : t.optional}
                </span>
                <input
                  type="date"
                  value={finish}
                  onChange={(e) => setFinish(e.target.value)}
                  className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-900 transition-colors focus:border-echo-orange focus:outline-none focus:ring-1 focus:ring-echo-orange"
                />
              </label>
            </div>

            {isConfirmed ? (
              <button
                onClick={saveDates}
                disabled={pending}
                className="mt-4 rounded-lg border border-gray-300 bg-white px-5 py-2 text-sm font-medium text-gray-900 transition-colors hover:bg-gray-50 disabled:opacity-50"
              >
                {pending ? t.saving : t.saveDates}
              </button>
            ) : (
              <>
                <button
                  onClick={confirm}
                  disabled={pending || datesBlockConfirm}
                  className="mt-4 rounded-lg bg-echo-orange px-5 py-2 text-sm font-medium text-white transition-colors hover:bg-echo-orange-hover disabled:opacity-50"
                >
                  {pending ? t.confirming : t.confirmOrder}
                </button>
                {datesBlockConfirm && <p className="mt-2 text-xs text-gray-500">{t.bothDatesHint}</p>}
              </>
            )}
          </>
        )}
      </Step>

      <Step number={3} title={t.step3Title} done={isFinished}>
        {isFinished ? (
          <p className="text-sm text-emerald-900">
            {fill(t.step3Done, {
              date: factoryDate(finishedAt, locale, { day: 'numeric', month: 'short', year: 'numeric' }),
            })}
          </p>
        ) : (
          <>
            <p className="text-sm text-gray-600">
              {t.step3BodyLead}
              <strong className="font-semibold text-gray-900">{t.step3BodyStrong}</strong>
              {t.step3BodyTail}
            </p>

            {!isConfirmed ? (
              <p className="mt-4 rounded-md border border-gray-200 bg-gray-50 px-4 py-3 text-sm text-gray-600">
                {t.step3ConfirmFirst}
              </p>
            ) : !confirming ? (
              <button
                onClick={() => setConfirming(true)}
                disabled={pending}
                className="mt-4 rounded-md bg-emerald-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-emerald-700 disabled:opacity-50"
              >
                {t.step3Button}
              </button>
            ) : (
              <div className="mt-4 rounded-md border border-gray-200 bg-gray-50 p-4">
                <p className="text-sm text-gray-900">{t.step3AreYouSure}</p>
                <div className="mt-3 flex gap-2">
                  <button
                    onClick={finished}
                    disabled={pending}
                    className="rounded-md bg-emerald-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-emerald-700 disabled:opacity-50"
                  >
                    {pending ? t.saving : t.step3Yes}
                  </button>
                  <button
                    onClick={() => setConfirming(false)}
                    className="rounded-md px-4 py-2 text-sm text-gray-600 transition-colors hover:bg-gray-100"
                  >
                    {t.step3No}
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </Step>

      {message && (
        <p className={`text-sm ${message.kind === 'ok' ? 'text-emerald-700' : 'text-red-700'}`}>
          {message.text}
        </p>
      )}
    </div>
  )
}

function Step({
  number,
  title,
  done,
  children,
}: {
  number: number
  title: string
  done: boolean
  children: React.ReactNode
}) {
  return (
    <section className={`rounded-lg border p-4 ${done ? 'border-emerald-200 bg-emerald-50/40' : 'border-gray-200'}`}>
      <div className="flex items-center gap-2.5">
        <span
          className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-bold ${
            done ? 'bg-emerald-600 text-white' : 'bg-gray-900 text-white'
          }`}
          aria-hidden
        >
          {done ? <CheckCircle2 className="h-4 w-4" /> : number}
        </span>
        <h2 className="text-sm font-semibold text-gray-900">{title}</h2>
      </div>
      <div className="mt-3 pl-8.5">{children}</div>
    </section>
  )
}
