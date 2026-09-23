'use client'
// page-state: none (a SPOT ID or reference typed and sent at once; nothing half done to keep)

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Plus } from 'lucide-react'
import { toast } from 'sonner'
import { addShipment } from '@/app/actions/cargo/track'

/**
 * Put a shipment on the board by hand: a SPOT ID, or a reference Cargo Partner knows it by.
 *
 * Dean, 23 Sep 2026: "theres no way to manually add spot ids or shipments or references?" The
 * Hub asks Cargo Partner first and keeps it only if it exists there.
 */
export default function AddShipment() {
  const [open, setOpen] = useState(false)
  const [value, setValue] = useState('')
  const [pending, startTransition] = useTransition()
  const router = useRouter()

  function submit(e: React.FormEvent) {
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
        setValue('')
        setOpen(false)
        router.refresh()
      } catch {
        toast.error('That did not go through. Please try again.')
      }
    })
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex shrink-0 items-center gap-2 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50"
      >
        <Plus className="h-4 w-4" /> Add a shipment
      </button>
    )
  }

  return (
    <form onSubmit={submit} className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
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
      <button
        type="button"
        onClick={() => {
          setOpen(false)
          setValue('')
        }}
        className="shrink-0 px-2 py-2 text-sm text-gray-500 hover:text-gray-800"
      >
        Cancel
      </button>
    </form>
  )
}
