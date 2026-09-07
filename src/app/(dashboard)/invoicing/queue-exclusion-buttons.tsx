'use client'

import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'
import { toast } from 'sonner'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { excludeDealFromQueue, restoreDealToQueue } from '@/app/actions/invoicing/queue-exclusions'

// page-state: none (one field, open only while the reason is being typed)

/**
 * "Not for the Hub": hold a deal out of the Accepted queue with a reason.
 *
 * The reason is required rather than optional because the only reader is the
 * next person wondering where a deal went, and "excluded" on its own tells
 * them nothing.
 */
export function ExcludeFromQueueButton({ dealId, dealName }: { dealId: string; dealName: string }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState('')
  const [pending, startTransition] = useTransition()

  const submit = () => {
    startTransition(async () => {
      const result = await excludeDealFromQueue({ dealId, reason })
      if (!result.success) {
        toast.error(result.error)
        return
      }
      toast.success(`${dealName} set aside`)
      setOpen(false)
      setReason('')
      router.refresh()
    })
  }

  if (!open) {
    return (
      <Button size="sm" variant="ghost" onClick={() => setOpen(true)} title="Hold this deal out of the queue">
        Not for the Hub
      </Button>
    )
  }

  return (
    <div className="flex items-center justify-end gap-2">
      <Input
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && reason.trim() !== '') submit()
          if (e.key === 'Escape') setOpen(false)
        }}
        placeholder="Why? e.g. invoiced in August outside the Hub"
        className="h-8 w-64"
        autoFocus
        disabled={pending}
      />
      <Button size="sm" onClick={submit} disabled={pending || reason.trim() === ''}>
        {pending && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
        Set aside
      </Button>
      <Button size="sm" variant="ghost" onClick={() => setOpen(false)} disabled={pending}>
        Cancel
      </Button>
    </div>
  )
}

/** Put a set-aside deal back in the queue. */
export function RestoreToQueueButton({ dealId }: { dealId: string }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()

  return (
    <Button
      size="sm"
      variant="outline"
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          const result = await restoreDealToQueue({ dealId })
          if (!result.success) {
            toast.error(result.error)
            return
          }
          toast.success('Back in the queue')
          router.refresh()
        })
      }
    >
      {pending && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
      Undo
    </Button>
  )
}
