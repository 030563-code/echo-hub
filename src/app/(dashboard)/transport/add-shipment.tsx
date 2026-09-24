'use client'
// page-state: none (a SPOT ID or reference typed and sent at once, or a depot picked; nothing half
// done to keep)

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Plus } from 'lucide-react'
import { toast } from 'sonner'
import { addShipment } from '@/app/actions/cargo/track'
import { createHandShipment } from '@/app/actions/transport/shipments'
import { depotLabel } from '@/lib/depot-constants'

/**
 * Put a shipment on the board by hand.
 *
 * Dean, 23 Sep 2026: "theres no way to manually add spot ids or shipments or references?" A SPOT ID
 * or a reference is checked with Cargo Partner first and kept only if it exists there.
 *
 * Dean, 24 Sep 2026: a container that is not booked yet, or not booked through us, still needs a
 * place in the Hub, or Dave keeps it in his sheet. So it can also be kept by hand: choose where it
 * is going, and the shipment's page takes everything else.
 */
export default function AddShipment({ handDepots }: { handDepots: string[] }) {
  const [mode, setMode] = useState<'closed' | 'spot' | 'hand'>('closed')
  const [value, setValue] = useState('')
  const [depot, setDepot] = useState(handDepots[0] ?? '')
  const [pending, startTransition] = useTransition()
  const router = useRouter()

  function close() {
    setMode('closed')
    setValue('')
  }

  function submitSpot(e: React.FormEvent) {
    e.preventDefault()
    if (!value.trim() || pending) return
    startTransition(async () => {
      try {
        const res = await addShipment({ value })
        if (!res.success) {
          toast.error(res.error)
          return
        }
        toast.success(res.message)
        close()
        router.refresh()
      } catch {
        toast.error('That did not go through. Please try again.')
      }
    })
  }

  function submitHand(e: React.FormEvent) {
    e.preventDefault()
    if (!depot || pending) return
    startTransition(async () => {
      try {
        const res = await createHandShipment({ depot })
        if (!res.success) {
          toast.error(res.error)
          return
        }
        toast.success(res.message)
        router.push(`/transport/${res.id}`)
      } catch {
        toast.error('That did not go through. Please try again.')
      }
    })
  }

  if (mode === 'closed') {
    return (
      <button
        type="button"
        onClick={() => setMode('spot')}
        className="inline-flex shrink-0 items-center gap-2 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50"
      >
        <Plus className="h-4 w-4" /> Add a shipment
      </button>
    )
  }

  // 🔴 Each form has its own key. Without them React reuses the DOM between the two, and the button
  // clicked to switch ("Not booked yet?") becomes the hand form's submit button during that same
  // click, so the browser submitted it: one click made a shipment before a depot was chosen.
  if (mode === 'hand') {
    return (
      <form key="hand" onSubmit={submitHand} className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
        <label className="text-sm text-gray-600" htmlFor="hand-depot">
          Going to
        </label>
        <select
          id="hand-depot"
          autoFocus
          value={depot}
          onChange={(e) => setDepot(e.target.value)}
          className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm focus:border-[#025945] focus:outline-none"
        >
          {handDepots.map((d) => (
            <option key={d} value={d}>
              {depotLabel(d)}
            </option>
          ))}
        </select>
        <button
          type="submit"
          disabled={pending || !depot}
          className="inline-flex shrink-0 items-center rounded-lg bg-[#025945] px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-[#03674f] disabled:opacity-60"
        >
          {pending ? 'Adding' : 'Keep it by hand'}
        </button>
        <button type="button" onClick={close} className="shrink-0 px-2 py-2 text-sm text-gray-500 hover:text-gray-800">
          Cancel
        </button>
      </form>
    )
  }

  return (
    <form key="spot" onSubmit={submitSpot} className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
      <input
        autoFocus
        value={value}
        onChange={(e) => setValue(e.target.value)}
        maxLength={80}
        aria-label="SPOT ID or order reference"
        placeholder="SPOT ID or order reference"
        className="min-w-56 flex-1 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm placeholder:text-gray-400 focus:border-[#025945] focus:outline-none"
      />
      <button
        type="submit"
        disabled={pending || !value.trim()}
        className="inline-flex shrink-0 items-center rounded-lg bg-[#025945] px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-[#03674f] disabled:opacity-60"
      >
        {pending ? 'Checking with Cargo Partner' : 'Add'}
      </button>
      {handDepots.length > 0 && (
        <button
          type="button"
          onClick={() => setMode('hand')}
          className="shrink-0 px-2 py-2 text-sm font-medium text-[#025945] hover:underline"
        >
          Not booked yet? Keep it by hand
        </button>
      )}
      <button type="button" onClick={close} className="shrink-0 px-2 py-2 text-sm text-gray-500 hover:text-gray-800">
        Cancel
      </button>
    </form>
  )
}
