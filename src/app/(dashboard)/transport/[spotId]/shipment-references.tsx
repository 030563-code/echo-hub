'use client'
// page-state: none (one short reference typed and saved at once, on this shipment only)

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { X } from 'lucide-react'
import { toast } from 'sonner'
import { addShipmentReference, removeShipmentReference } from '@/app/actions/cargo/track'
import type { ShipmentReference } from '@/lib/cargo/store'

/**
 * Our own references on a shipment (a PO number, a customer's reference), beside the order numbers
 * the shipping sheet already carries. Both are searched on the board.
 */
export default function ShipmentReferences({
  spotId,
  own,
  sheet,
}: {
  spotId: string
  own: ShipmentReference[]
  sheet: string[]
}) {
  const [value, setValue] = useState('')
  const [pending, startTransition] = useTransition()
  const router = useRouter()

  function run(action: () => Promise<{ success: true; message: string } | { success: false; error: string }>, after?: () => void) {
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

  return (
    <div className="mt-5 border-t border-gray-100 pt-4">
      <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-400">References</p>
      {own.length + sheet.length > 0 ? (
        <ul className="flex flex-wrap gap-2">
          {own.map((r) => (
            <li
              key={r.id}
              className="inline-flex items-center gap-1 rounded-full bg-gray-100 py-1 pl-3 pr-1.5 text-sm text-gray-800"
            >
              {r.reference}
              <button
                type="button"
                disabled={pending}
                onClick={() => run(() => removeShipmentReference({ id: r.id }))}
                aria-label={`Remove ${r.reference}`}
                className="rounded-full p-0.5 text-gray-500 hover:bg-gray-200 hover:text-gray-800 disabled:opacity-50"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </li>
          ))}
          {sheet.map((r) => (
            <li
              key={`sheet-${r}`}
              title="From the shipping sheet"
              className="inline-flex items-center rounded-full px-3 py-1 text-sm text-gray-600 ring-1 ring-inset ring-gray-200"
            >
              {r}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-gray-500">None yet.</p>
      )}
      {sheet.length > 0 && <p className="mt-1.5 text-xs text-gray-400">The outlined ones come from the shipping sheet.</p>}
      <form
        onSubmit={(e) => {
          e.preventDefault()
          if (!value.trim() || pending) return
          run(() => addShipmentReference({ spotId, reference: value }), () => setValue(''))
        }}
        className="mt-3 flex flex-wrap gap-2"
      >
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          maxLength={80}
          aria-label="Add a reference"
          placeholder="Add a reference, such as a PO number"
          className="min-w-56 flex-1 rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm placeholder:text-gray-400 focus:border-[#025945] focus:outline-none"
        />
        <button
          type="submit"
          disabled={pending || !value.trim()}
          className="shrink-0 rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-60"
        >
          Add
        </button>
      </form>
    </div>
  )
}
