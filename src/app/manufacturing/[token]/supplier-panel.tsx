'use client'

// page-state: none (this screen belongs to a supplier with no Hub account and
// no user_page_state row. The two dates are saved to po_manufacturing by an
// explicit Save, so there is no draft to keep.)

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { CheckCircle2 } from 'lucide-react'
import {
  saveManufacturingDates,
  markManufacturingFinished,
} from '@/app/actions/manufacturing/supplier-updates'

/**
 * The two things Bamida do here: give their dates, and say it is finished.
 *
 * Finished is deliberately behind a confirmation, and once pressed there is no
 * way back on this page. The Hub hangs the transport booking on that timestamp.
 */
export default function SupplierPanel({
  token,
  estStart,
  estFinish,
  finishedAt,
}: {
  token: string
  estStart: string | null
  estFinish: string | null
  finishedAt: string | null
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [start, setStart] = useState(estStart ?? '')
  const [finish, setFinish] = useState(estFinish ?? '')
  const [confirming, setConfirming] = useState(false)
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)

  if (finishedAt) {
    return (
      <div className="mt-6 flex items-start gap-3 rounded-lg border border-emerald-200 bg-emerald-50 p-4">
        <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-emerald-600" />
        <div>
          <p className="text-sm font-medium text-emerald-900">
            You marked this order finished on {new Date(finishedAt).toLocaleDateString('en-GB')}.
          </p>
          <p className="mt-1 text-sm text-emerald-800">
            Echo Barrier have been told. There is nothing else to do here.
          </p>
        </div>
      </div>
    )
  }

  function saveDates() {
    setMessage(null)
    startTransition(async () => {
      const res = await saveManufacturingDates({
        token,
        estStart: start === '' ? null : start,
        estFinish: finish === '' ? null : finish,
      })
      setMessage(res.ok ? { kind: 'ok', text: 'Saved. Thank you.' } : { kind: 'error', text: res.error })
      if (res.ok) router.refresh()
    })
  }

  function finished() {
    setConfirming(false)
    setMessage(null)
    startTransition(async () => {
      const res = await markManufacturingFinished({ token })
      if (!res.ok) setMessage({ kind: 'error', text: res.error })
      else router.refresh()
    })
  }

  return (
    <div className="mt-6 space-y-6">
      <div className="rounded-lg border border-gray-200 p-4">
        <h2 className="text-sm font-semibold text-gray-900">When do you expect to build it?</h2>
        <p className="mt-1 text-sm text-gray-600">
          You can change these as often as you need to, right up until you mark the order finished.
        </p>

        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <label className="block">
            <span className="text-xs font-medium uppercase tracking-wider text-gray-500">Start</span>
            <input
              type="date"
              value={start}
              onChange={(e) => setStart(e.target.value)}
              className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-900 transition-colors focus:border-echo-orange focus:outline-none focus:ring-1 focus:ring-echo-orange"
            />
          </label>
          <label className="block">
            <span className="text-xs font-medium uppercase tracking-wider text-gray-500">Finish</span>
            <input
              type="date"
              value={finish}
              onChange={(e) => setFinish(e.target.value)}
              className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-900 transition-colors focus:border-echo-orange focus:outline-none focus:ring-1 focus:ring-echo-orange"
            />
          </label>
        </div>

        <button
          onClick={saveDates}
          disabled={pending}
          className="mt-4 rounded-lg bg-echo-orange px-5 py-2 text-sm font-medium text-white transition-colors hover:bg-echo-orange-hover disabled:opacity-50"
        >
          {pending ? 'Saving...' : 'Save dates'}
        </button>
      </div>

      <div className="rounded-lg border border-gray-200 p-4">
        <h2 className="text-sm font-semibold text-gray-900">Is it made?</h2>
        <p className="mt-1 text-sm text-gray-600">
          Press this once the barriers are finished and ready to collect. Echo Barrier arrange
          transport from here, so it can only be pressed once.
        </p>

        {!confirming ? (
          <button
            onClick={() => setConfirming(true)}
            disabled={pending}
            className="mt-4 rounded-md bg-emerald-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-emerald-700 disabled:opacity-50"
          >
            Manufacturing finished
          </button>
        ) : (
          <div className="mt-4 rounded-md border border-gray-200 bg-gray-50 p-4">
            <p className="text-sm text-gray-900">
              Are the barriers on this order finished and ready to collect? This cannot be undone.
            </p>
            <div className="mt-3 flex gap-2">
              <button
                onClick={finished}
                disabled={pending}
                className="rounded-md bg-emerald-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-emerald-700 disabled:opacity-50"
              >
                {pending ? 'Saving...' : 'Yes, it is finished'}
              </button>
              <button
                onClick={() => setConfirming(false)}
                className="rounded-md px-4 py-2 text-sm text-gray-600 transition-colors hover:bg-gray-100"
              >
                Not yet
              </button>
            </div>
          </div>
        )}
      </div>

      {message && (
        <p className={`text-sm ${message.kind === 'ok' ? 'text-emerald-700' : 'text-red-700'}`}>
          {message.text}
        </p>
      )}
    </div>
  )
}
