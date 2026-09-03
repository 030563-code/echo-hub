'use client'

import { useRouter } from 'next/navigation'
import { useTransition } from 'react'
import { toast } from 'sonner'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { openInvoiceForDeal } from '@/app/actions/invoicing/open-invoice'

/**
 * Queue-row action: find-or-create the draft invoice for the deal, then
 * navigate into the editor. Every navigation shows a pending state (reps and
 * reviewers double-click when nothing responds).
 */
export function OpenInvoiceButton({
  dealId,
  hasInvoice,
  canManage = true,
}: {
  dealId: string
  hasInvoice: boolean
  canManage?: boolean
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()

  const open = () => {
    startTransition(async () => {
      // openInvoiceForDeal needs invoicing.manage; a view-only user just opens
      // the detail page, which renders read-only.
      if (!canManage) {
        router.push(`/invoicing/${dealId}`)
        return
      }
      const result = await openInvoiceForDeal({ dealId })
      if (!result.success) {
        toast.error(result.error)
        return
      }
      router.push(`/invoicing/${dealId}`)
    })
  }

  return (
    <Button size="sm" variant={hasInvoice ? 'outline' : 'primary'} onClick={open} disabled={pending}>
      {pending && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
      {hasInvoice || !canManage ? 'Open' : 'Review'}
    </Button>
  )
}
