'use client'

// page-state: none (a busy flag and a resend confirmation. Both are gone the
// moment the action returns, and the durable record is the po_manufacturing row
// the server writes.)

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Mail, CheckCircle2, Clock } from 'lucide-react'
import {
  sendManufacturingPoToBamida,
  releaseBamidaSendClaim,
} from '@/app/actions/purchase-orders/send-manufacturing-po'

type Manufacturing = {
  sentAt: string | null
  sentTo: string[]
  sentWasTest: boolean
  estStart: string | null
  estFinish: string | null
  finishedAt: string | null
}

const date = (v: string | null) => (v ? new Date(v).toLocaleDateString('en-GB') : null)

/**
 * The manufacturing order, and whether Bamida have it.
 *
 * The send state is shown plainly, including whether it went to the test
 * address. Nobody should have to read an environment variable to know whether a
 * real email left the building.
 */
export default function ManufacturingCard({
  poId,
  canAct,
  manufacturing,
}: {
  poId: string
  canAct: boolean
  manufacturing: Manufacturing
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [confirmingResend, setConfirmingResend] = useState(false)

  const sent = manufacturing.sentAt !== null
  const finished = manufacturing.finishedAt !== null

  function send() {
    startTransition(async () => {
      const res = await sendManufacturingPoToBamida({ manufacturing_po_id: poId })
      if (!res.ok) toast.error(res.error)
      else if (res.short) toast.warning(`${res.description}. They were told which materials are short.`)
      else toast.success(res.description)
      router.refresh()
    })
  }

  function resend() {
    setConfirmingResend(false)
    startTransition(async () => {
      const res = await releaseBamidaSendClaim({ manufacturing_po_id: poId })
      if (!res.ok) toast.error(res.error)
      else toast.success('Reopened. Press Send to Bamida to send it again.')
      router.refresh()
    })
  }

  return (
    <div className="rounded-xl border border-gray-200 bg-white p-5">
      <h2 className="text-base font-semibold text-gray-900" style={{ fontFamily: 'Varela Round, sans-serif' }}>
        Manufacturing
      </h2>

      <div className="mt-4 space-y-2.5 text-sm">
        <Row
          icon={<Mail className="w-4 h-4" />}
          label="Sent to Bamida"
          value={
            !sent ? (
              <span className="text-gray-500">not yet</span>
            ) : manufacturing.sentWasTest ? (
              <span className="text-amber-700">
                {date(manufacturing.sentAt)} to the test address ({manufacturing.sentTo.join(', ')}), not Bamida
              </span>
            ) : (
              <span className="text-gray-900">
                {date(manufacturing.sentAt)} to {manufacturing.sentTo.join(', ')}
              </span>
            )
          }
        />
        <Row
          icon={<Clock className="w-4 h-4" />}
          label="Bamida's dates"
          value={
            manufacturing.estStart || manufacturing.estFinish ? (
              <span className="text-gray-900">
                {date(manufacturing.estStart) ?? 'start not given'} to{' '}
                {date(manufacturing.estFinish) ?? 'finish not given'}
              </span>
            ) : (
              <span className="text-gray-500">not given yet</span>
            )
          }
        />
        <Row
          icon={<CheckCircle2 className="w-4 h-4" />}
          label="Finished"
          value={
            finished ? (
              <span className="text-emerald-700">{date(manufacturing.finishedAt)}</span>
            ) : (
              <span className="text-gray-500">not yet</span>
            )
          }
        />
      </div>

      {canAct && !finished && (
        <div className="mt-5 flex flex-wrap gap-2">
          {!sent && (
            <button
              onClick={send}
              disabled={pending}
              className="px-5 py-2 bg-echo-orange hover:bg-echo-orange-hover text-white text-sm font-medium rounded-lg disabled:opacity-50 transition-colors"
            >
              {pending ? 'Sending...' : 'Send to Bamida'}
            </button>
          )}

          {sent && !confirmingResend && (
            <button
              onClick={() => setConfirmingResend(true)}
              disabled={pending}
              className="px-4 py-2 text-sm rounded-lg border border-gray-300 text-gray-700 hover:text-gray-900 hover:bg-gray-100 disabled:opacity-50 transition-colors"
            >
              Send it again
            </button>
          )}

          {sent && confirmingResend && (
            <div className="w-full rounded-lg border border-gray-200 bg-gray-50 p-4">
              <p className="text-sm text-gray-900">
                Bamida already have this order. Sending it again puts a second copy of the same
                purchase order in front of the factory.
              </p>
              <div className="mt-3 flex gap-2">
                <button
                  onClick={resend}
                  disabled={pending}
                  className="px-4 py-2 bg-echo-orange hover:bg-echo-orange-hover text-white text-sm font-medium rounded-lg disabled:opacity-50 transition-colors"
                >
                  Reopen it for sending
                </button>
                <button
                  onClick={() => setConfirmingResend(false)}
                  className="px-4 py-2 text-sm text-gray-700 hover:text-gray-900 rounded-lg hover:bg-gray-100 transition-colors"
                >
                  Leave it
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {finished && (
        <p className="mt-5 text-xs text-gray-400">
          Bamida have finished this order, so it can no longer be sent or reopened.
        </p>
      )}

      {!canAct && (
        <p className="mt-5 text-xs text-gray-400">Read only. You need po.create to send this order.</p>
      )}
    </div>
  )
}

function Row({ icon, label, value }: { icon: React.ReactNode; label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-start gap-3">
      <span className="text-gray-400 mt-0.5">{icon}</span>
      <span className="text-gray-500 w-32 shrink-0">{label}</span>
      <span className="flex-1">{value}</span>
    </div>
  )
}
