'use client'
// page-state: none (one button behind a confirm)

import { useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Trash2 } from 'lucide-react'
import { removeHandAddedShipment } from '@/app/actions/cargo/track'

/**
 * Take a SPOT added by hand back off the board. Shown only for one that was; the server still
 * refuses one that anything else knows, and says why.
 */
export default function RemoveShipmentButton({ spotId, typed }: { spotId: string; typed: string | null }) {
  const [pending, startTransition] = useTransition()
  const router = useRouter()

  function remove() {
    const what = typed ? `\n\nWhat was typed on it goes too: ${typed}.` : ''
    if (
      !window.confirm(
        `Take SPOT ${spotId} off the board?\n\nIt was added by hand. Cargo Partner is not told, and it can be added again later.${what}`,
      )
    )
      return
    startTransition(async () => {
      try {
        const res = await removeHandAddedShipment({ spotId })
        if (!res.success) {
          toast.error(res.error)
          return
        }
        toast.success(res.message)
        router.push('/transport')
      } catch {
        toast.error('That did not go through. Please try again.')
      }
    })
  }

  return (
    <button
      type="button"
      onClick={remove}
      disabled={pending}
      className="inline-flex items-center gap-1.5 rounded-lg border border-red-200 bg-white px-3 py-1.5 text-sm font-medium text-red-700 transition-colors hover:bg-red-50 disabled:opacity-60"
    >
      <Trash2 className="h-4 w-4" /> {pending ? 'Removing' : 'Remove from the board'}
    </button>
  )
}
