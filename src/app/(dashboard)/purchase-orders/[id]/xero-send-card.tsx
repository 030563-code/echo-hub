'use client'

// page-state: none (a tick box and a busy flag for one press. The durable record of every send
// is the one the server writes to po_xero_sends.)

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Loader2, RotateCw } from 'lucide-react'
import { sendToXeroAgain } from '@/app/actions/purchase-orders/send-to-xero-again'
import XeroSendNotice from '@/components/po/xero-send-notice'
import type { XeroSendView } from '@/lib/po-xero-send'

/**
 * An approved leg that is not in Xero, said plainly, and the way to send it again.
 *
 * The tick box is not a formality. n8n creates a new Xero purchase order on every run and does
 * not look for one with the same number first, and a run can fail after Xero has made the order.
 * So the only person who can know a second send is safe is the one who has just looked in Xero.
 * The server checks the tick too, against this order's number.
 */
export default function XeroSendCard({
  poId,
  poNumber,
  view,
  xeroOrganisation,
  canApprove,
}: {
  poId: string
  poNumber: string
  view: XeroSendView
  /** The legal name of the Xero organisation the order belongs in, to say where to look. */
  xeroOrganisation: string | null
  canApprove: boolean
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [checked, setChecked] = useState(false)

  const canRetry = view.kind === 'failed' && canApprove

  function send() {
    startTransition(async () => {
      const res = await sendToXeroAgain({ poId, checkedXeroFor: poNumber, attempts: view.attempts })
      if (res.ok) toast.success(res.description)
      else toast.error(res.error, { duration: Infinity })
      setChecked(false)
      router.refresh()
    })
  }

  return (
    <div className="rounded-xl border border-gray-200 bg-white p-5 mb-6">
      <h2 className="text-base font-semibold text-gray-900" style={{ fontFamily: 'Varela Round, sans-serif' }}>
        Xero
      </h2>
      <div className="mt-3">
        <XeroSendNotice view={view} />
      </div>

      {canRetry && (
        <div className="mt-4 space-y-3">
          <p className="text-sm text-gray-600">
            n8n does not check Xero before it creates a purchase order, so sending one Xero already has makes a
            second copy. A send that failed part way can leave a draft there too.
          </p>
          <label className="flex items-start gap-2 text-sm text-gray-900">
            <input
              type="checkbox"
              checked={checked}
              onChange={(e) => setChecked(e.target.checked)}
              disabled={pending}
              className="mt-0.5 h-4 w-4 rounded border-gray-300 accent-echo-orange"
            />
            <span>
              I have looked for <span className="font-mono">{poNumber}</span> in Xero
              {xeroOrganisation ? <> ({xeroOrganisation})</> : null}, drafts included, and it is not there.
            </span>
          </label>
          <button
            onClick={send}
            disabled={!checked || pending}
            className="inline-flex items-center gap-2 px-4 py-2 bg-echo-orange hover:bg-echo-orange-hover text-white text-sm font-medium rounded-lg disabled:opacity-50 transition-colors"
          >
            {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <RotateCw className="h-4 w-4" />}
            {pending ? 'Sending...' : 'Send to Xero again'}
          </button>
        </div>
      )}

      {view.kind === 'failed' && !canApprove && (
        <p className="mt-3 text-xs text-gray-500">Somebody with po.approve can send it to Xero again from this page.</p>
      )}
    </div>
  )
}
