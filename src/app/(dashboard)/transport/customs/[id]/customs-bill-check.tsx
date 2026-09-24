'use client'
// page-state: none (a short note typed and sent at once; the sign-off itself is on the bill)

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { CheckCircle2 } from 'lucide-react'
import { toast } from 'sonner'
import { markCustomsBillChecked, undoCustomsBillChecked, type CustomsActionResult } from '@/app/actions/customs/bills'

/**
 * Dean, 24 Sep 2026: "Some of the things say need a look but theres no way to edit in the Hub."
 *
 * Some flags are true and understood: a rate Nippon filed on purpose, a bill with no duty on it.
 * Dave signs those off with a word on why, and the bill stops asking. A sign-off lapses by itself
 * when the reading is corrected and the checks change.
 */
export function CustomsBillCheck({
  billId,
  signedOff,
  lapsed,
}: {
  billId: string
  /** Dave's sign-off while it still applies. */
  signedOff: { by: string; on: string; note: string } | null
  /** A sign-off was given, but the checks have changed since. */
  lapsed: boolean
}) {
  const [note, setNote] = useState('')
  const [pending, startTransition] = useTransition()
  const router = useRouter()

  function run(action: () => Promise<CustomsActionResult>, after?: () => void) {
    startTransition(async () => {
      try {
        const res = await action()
        if (!res.success) {
          toast.error(res.error)
          return
        }
        toast.success(res.message)
        after?.()
        router.refresh()
      } catch {
        toast.error('That did not go through. Please try again.')
      }
    })
  }

  if (signedOff) {
    return (
      <div className="flex flex-wrap items-start justify-between gap-3 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3">
        <p className="flex items-start gap-2 text-sm text-emerald-900">
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
          <span>
            Checked by {signedOff.by} on {signedOff.on}: {signedOff.note}
          </span>
        </p>
        <button
          type="button"
          disabled={pending}
          onClick={() => run(() => undoCustomsBillChecked(billId))}
          className="shrink-0 text-sm font-medium text-emerald-800 hover:underline disabled:opacity-60"
        >
          Undo
        </button>
      </div>
    )
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        if (!note.trim() || pending) return
        run(() => markCustomsBillChecked(billId, note), () => setNote(''))
      }}
      className="rounded-xl border border-gray-200 bg-white px-4 py-3"
    >
      <label htmlFor="check-note" className="text-sm font-medium text-gray-900">
        Looked into it?
      </label>
      <p className="mb-2 text-sm text-gray-500">
        {lapsed
          ? 'This was marked as checked, but the reading has changed since. Look again and say what you found.'
          : 'If what is flagged is right, or explained, say what you found and it stops asking. Correct the reading instead if a figure is misread.'}
      </p>
      <div className="flex flex-wrap gap-2">
        <input
          id="check-note"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          maxLength={1000}
          placeholder="Nippon confirmed the rate, the bill is for storage only..."
          className="min-w-64 flex-1 rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm placeholder:text-gray-400 focus:border-[#025945] focus:outline-none"
        />
        <button
          type="submit"
          disabled={pending || !note.trim()}
          className="shrink-0 rounded-lg bg-[#025945] px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-[#03674f] disabled:opacity-60"
        >
          {pending ? 'Saving' : 'Mark as checked'}
        </button>
      </div>
    </form>
  )
}
