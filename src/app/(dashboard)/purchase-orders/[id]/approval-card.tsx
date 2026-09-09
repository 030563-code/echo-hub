'use client'

// page-state: none (a busy flag, a confirm panel and an optional rejection
// reason. None of it outlives the press, and the durable record is the approval
// or the rejection note the server writes onto the PO.)

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { decidePurchaseOrder } from '@/app/actions/purchase-orders/decide-po'
import { displayPoNumber } from '@/lib/po-number'

const inputCls =
  'w-full px-3 py-2 bg-white border border-gray-300 rounded-lg text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:border-echo-orange transition-colors'

/** What approving THIS leg sets off, taken from decide-po rather than guessed. */
function consequences(leg: string, tier: string): string[] {
  const out: string[] = []
  if (leg === 'DEPOT_TO_EB_GROUP') {
    out.push('The next tier is raised as a new purchase order, waiting on its own approval.')
  }
  // Deliberately hedged. decide-po fires the Xero hand-off only when a webhook
  // URL is set and external calls are not disabled, and treats a refusal as a
  // warning on an otherwise successful approval. A confirm that promises a Xero
  // purchase order is worse than none when staging never creates one.
  out.push(`The ${tier} purchase order is handed to n8n to create in Xero. If that hand-off is off or fails, you are told, and the approval still stands.`)
  if (leg === 'EB_GROUP_TO_SRO') {
    out.push('The order sits with SRO, and an email tells them a fulfilment decision is waiting.')
  }
  if (leg === 'SRO_TO_SUPPLIER') {
    out.push('Nothing further is raised, this is the last tier.')
  }
  return out
}

/**
 * Approve or reject this leg, from the order's own page.
 *
 * The approvals queue is for somebody working through a pile. This is for the
 * person who followed a link to one order and should not have to go and find it
 * in a list to answer it.
 *
 * Approving is not undoable and reaches outside the Hub, so it sits behind a
 * confirm that says what it will do on this leg specifically.
 */
export default function ApprovalCard({
  poId,
  poNumber,
  tier,
  leg,
  status,
  source,
  canApprove,
}: {
  poId: string
  poNumber: string | null
  tier: string
  leg: string
  /** The two fields decide-po actually gates on, so the card can refuse itself. */
  status: string
  source: string
  canApprove: boolean
}) {

  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [confirmingApprove, setConfirmingApprove] = useState(false)
  const [rejecting, setRejecting] = useState(false)
  const [note, setNote] = useState('')

  // The caller decides whether to render this at all, but the card carries the
  // gate too: an order that is not awaiting Hub approval can only ever produce
  // the action's own refusal, and a button that cannot work should not be drawn.
  // After the hooks, never before, or the hook order changes between renders.
  if (source !== 'hub' || status !== 'requested') return null

  function approve() {
    setConfirmingApprove(false)
    startTransition(async () => {
      const res = await decidePurchaseOrder({ poId, decision: 'approve' })
      if (!res.success) {
        toast.error(res.error)
      } else {
        toast.success(
          res.nextPoNumber
            ? `${res.tier} approved. The next tier was raised as ${res.nextPoNumber}.`
            : res.awaitingFulfilment
              ? `${res.tier} approved. It is now with SRO, who choose whether to fulfil it from stock or manufacture it.`
              : `${res.tier} approved. Final tier, the chain is complete.`,
        )
        // A warning rides alongside success (the Xero hand-off or the SRO email
        // not confirming), and it is the half nobody else will tell them about.
        if (res.warning) toast.warning(res.warning)
      }
      router.refresh()
    })
  }

  function reject() {
    const reason = note.trim()
    setRejecting(false)
    setNote('')
    startTransition(async () => {
      const res = await decidePurchaseOrder({ poId, decision: 'reject', note: reason || undefined })
      if (!res.success) toast.error(res.error)
      else toast.success(`${displayPoNumber(poNumber)} rejected`)
      router.refresh()
    })
  }

  return (
    <div className="rounded-xl border border-gray-200 bg-white p-5">
      <h2 className="text-base font-semibold text-gray-900" style={{ fontFamily: 'Varela Round, sans-serif' }}>
        {tier} approval
      </h2>
      <p className="text-sm text-gray-500 mt-1">
        {displayPoNumber(poNumber)} is waiting on this tier. Approving carries the chain on, rejecting
        stops it here.
      </p>

      {canApprove && (
        <div className="mt-5 flex flex-wrap gap-2">
          {!confirmingApprove && !rejecting && (
            <>
              <button
                onClick={() => setConfirmingApprove(true)}
                disabled={pending}
                className="px-5 py-2 bg-echo-orange hover:bg-echo-orange-hover text-white text-sm font-medium rounded-lg disabled:opacity-50 transition-colors"
              >
                {pending ? 'Working...' : 'Approve'}
              </button>
              <button
                onClick={() => setRejecting(true)}
                disabled={pending}
                className="px-4 py-2 text-sm rounded-lg border border-red-200 text-red-700 hover:bg-red-50 disabled:opacity-50 transition-colors"
              >
                Reject
              </button>
            </>
          )}

          {confirmingApprove && (
            <div className="w-full rounded-lg border border-gray-200 bg-gray-50 p-4">
              <p className="text-sm text-gray-900">Approving {displayPoNumber(poNumber)} does this:</p>
              <ul className="mt-2 space-y-1 text-sm text-gray-600 list-disc pl-5">
                {consequences(leg, tier).map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
              <div className="mt-3 flex gap-2">
                <button
                  onClick={approve}
                  disabled={pending}
                  className="px-5 py-2 bg-echo-orange hover:bg-echo-orange-hover text-white text-sm font-medium rounded-lg disabled:opacity-50 transition-colors"
                >
                  {pending ? 'Approving...' : 'Approve it'}
                </button>
                <button
                  onClick={() => setConfirmingApprove(false)}
                  className="px-4 py-2 text-sm text-gray-700 hover:text-gray-900 rounded-lg hover:bg-gray-100 transition-colors"
                >
                  Leave it
                </button>
              </div>
            </div>
          )}

          {rejecting && (
            <div className="w-full rounded-lg border border-gray-200 bg-gray-50 p-4">
              <p className="text-sm text-gray-900">
                This marks the PO rejected and stops the chain at this tier. Add an optional reason.
              </p>
              <textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                rows={3}
                placeholder="Reason (optional)…"
                className={inputCls + ' resize-none mt-3'}
              />
              <div className="mt-3 flex gap-2">
                <button
                  onClick={reject}
                  disabled={pending}
                  className="px-4 py-2 text-sm rounded-lg border border-red-200 text-red-700 hover:bg-red-50 disabled:opacity-50 transition-colors"
                >
                  {pending ? 'Rejecting...' : 'Reject PO'}
                </button>
                <button
                  onClick={() => setRejecting(false)}
                  className="px-4 py-2 text-sm text-gray-700 hover:text-gray-900 rounded-lg hover:bg-gray-100 transition-colors"
                >
                  Leave it
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {!canApprove && (
        <p className="mt-5 text-xs text-gray-400">Read only. You need po.approve to decide this order.</p>
      )}
    </div>
  )
}
