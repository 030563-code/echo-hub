'use client'

// page-state: none (the date belongs to the deal and is written to HubSpot on Save, not held here)

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Loader2, Pencil } from 'lucide-react'
import { updateDealCloseDate } from '@/app/actions/hubspot/updateDealCloseDate'
import { closeDayForInput, closeDayProblem, todayUtc } from '@/lib/close-date'
import { daysPastClose } from '@/lib/past-close'
import { formatDate } from '@/lib/utils'

/**
 * A deal's close date, changed in the Hub.
 *
 * Dean, 24 Sep 2026: "Okay add a close date field in the Hub please." On the deal page it reads as
 * a field with Change beside it; on the past-close banner it is the row's own way to fix the date,
 * in place of the link out to HubSpot. Saving writes closedate only (updateDealCloseDate), then
 * refreshes the page, so a deal given a future date drops off the banner straight away.
 *
 * `openDeal` decides whether a date in the past is shown as a problem: for a deal already won or
 * lost the close date is simply when it closed.
 */
export function CloseDateField({
  dealId,
  closedate,
  canEdit,
  openDeal = true,
  variant = 'deal',
}: {
  dealId: string
  closedate: string | null | undefined
  canEdit: boolean
  openDeal?: boolean
  variant?: 'deal' | 'banner'
}) {
  const router = useRouter()
  const current = closeDayForInput(closedate)
  const [editing, setEditing] = useState(variant === 'banner')
  // A banner row starts empty: the old date is printed beside it, and Save waits for a new one.
  const [day, setDay] = useState(variant === 'banner' ? '' : current)
  const [pending, startTransition] = useTransition()
  // Read once, so a re-render never moves "today" under the person typing.
  const [nowMs] = useState(() => Date.now())
  const past = openDeal ? daysPastClose(current, nowMs) : null
  // An overdue deal needs a date from today on to come off the list; the deal page allows any.
  const min = variant === 'banner' ? todayUtc(nowMs) : undefined

  function save() {
    const problem = closeDayProblem(day, Date.now())
    if (problem) {
      toast.error(problem)
      return
    }
    if (day === current) {
      if (variant === 'deal') setEditing(false)
      return
    }
    startTransition(async () => {
      const res = await updateDealCloseDate({ dealId, closeDay: day })
      if (!res.success) {
        toast.error(res.error)
        return
      }
      toast.success(`Close date moved to ${formatDate(day)}`)
      if (variant === 'deal') setEditing(false)
      router.refresh()
    })
  }

  if (!editing || !canEdit) {
    return (
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="text-gray-900">{current ? formatDate(current) : 'Not set'}</span>
        {past !== null && (
          <span className="text-xs font-medium text-red-700">
            {past} {past === 1 ? 'day' : 'days'} ago
          </span>
        )}
        {canEdit && (
          <button
            type="button"
            onClick={() => {
              setDay(current)
              setEditing(true)
            }}
            className="inline-flex items-center gap-1 text-xs font-medium text-gray-600 hover:text-gray-900 hover:underline"
            aria-label="Change the close date"
          >
            <Pencil className="h-3 w-3" aria-hidden="true" /> Change
          </button>
        )}
      </div>
    )
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <input
        type="date"
        value={day}
        min={min}
        onChange={(e) => setDay(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') save()
          if (e.key === 'Escape' && variant === 'deal') setEditing(false)
        }}
        aria-label={variant === 'banner' ? 'New close date' : 'Close date'}
        className="rounded-md border border-gray-300 bg-white px-2 py-1 text-sm text-gray-900 focus:border-echo-orange focus:outline-none"
      />
      <button
        type="button"
        onClick={save}
        disabled={pending || !day}
        className="inline-flex items-center gap-1 rounded-md bg-gray-900 px-2.5 py-1 text-xs font-medium text-white hover:bg-gray-800 disabled:opacity-50"
      >
        {pending && <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />}
        {variant === 'banner' ? 'Save date' : 'Save'}
      </button>
      {variant === 'deal' && (
        <button
          type="button"
          onClick={() => setEditing(false)}
          disabled={pending}
          className="text-xs text-gray-500 hover:text-gray-800"
        >
          Cancel
        </button>
      )}
    </div>
  )
}
