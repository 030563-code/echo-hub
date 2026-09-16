'use client'

// page-state: none (a busy flag that lives only as long as the request it guards)

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Loader2, Paperclip } from 'lucide-react'
import { attachPoPdf } from '@/app/actions/purchase-orders/attach-po-pdf'

/**
 * Put this purchase order's PDF onto its Xero purchase order.
 *
 * The REPAIR path. Approving an order normally attaches its document in the same
 * n8n run that creates the Xero purchase order, so this button is for the orders
 * that did not get one: the two raised before any of this existed, and any later
 * one whose attach failed while the order itself went through.
 *
 * Only shown once the Xero purchase order exists, because the id is what this
 * attaches to. Nothing here can create one: see attach-po-pdf.ts.
 */
export default function AttachPoPdfButton({ poId, poNumber }: { poId: string; poNumber: string }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [done, setDone] = useState(false)

  return (
    <button
      onClick={() =>
        startTransition(async () => {
          const res = await attachPoPdf({ po_id: poId })
          if (!res.ok) toast.error(res.error)
          else {
            setDone(true)
            toast.success(res.description)
          }
          router.refresh()
        })
      }
      disabled={pending}
      title={`Attach the ${poNumber} PDF to its purchase order in Xero`}
      className="w-full inline-flex items-center justify-center gap-2 rounded-lg border border-gray-300 px-3 py-2 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-100 hover:text-gray-900 disabled:opacity-60"
    >
      {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Paperclip className="h-4 w-4" />}
      {done ? 'Attached to Xero' : 'Attach PDF to Xero'}
    </button>
  )
}
