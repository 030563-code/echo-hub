'use client'

// page-state: none (a busy flag, a resend confirmation and the send preview.
// All are gone the moment the action returns, and the durable record is the
// po_manufacturing row the server writes.)

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Mail, CheckCircle2, Clock } from 'lucide-react'
import {
  sendManufacturingPoToBamida,
  previewManufacturingPoSend,
  releaseBamidaSendClaim,
} from '@/app/actions/purchase-orders/send-manufacturing-po'
import SendConfirmDialog from '@/components/po/send-confirm-dialog'
import type { SendPreview } from '@/lib/send-preview'

type Manufacturing = {
  sentAt: string | null
  sentTo: string[]
  sentWasTest: boolean
  estStart: string | null
  estFinish: string | null
  confirmedAt: string | null
  confirmedBy: string | null
  finishedAt: string | null
  finishedBy: string | null
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
  contact,
  specConfirmed,
  specSaved,
}: {
  poId: string
  canAct: boolean
  manufacturing: Manufacturing
  /** The manufacturer's one address, shown so the sender can see it. Read only. */
  contact: string
  /**
   * 🔴 Whether the -1 specification has been signed off. The SERVER refuses an unconfirmed send;
   * this only stops somebody walking into a refusal they could have been told about.
   * Dean, 17 Sep 2026, on pressing Send to Bamida without opening the specification: "does it send
   * with that red line?" It did.
   */
  specConfirmed: boolean
  specSaved: boolean
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [confirmingResend, setConfirmingResend] = useState(false)
  // Dean, 9 Sep 2026: Juraj says Bamida have several points of contact, so the
  // send needs the same editable address boxes the shipment request has. Blank
  // falls back to the server's configured list rather than sending to nobody.
  // 🔴 Not state and not editable. Dean, 17 Sep 2026: "here is the absolute point of contact to
  // Bamida / sklad@bamida.sk / It should no longer be an editable field." The SERVER decides it;
  // this is shown so nobody has to guess where the order went.
  // The confirmation, added 16 Sep 2026. Nothing reaches the factory until
  // somebody has read who it goes to, which is the one thing a person can get
  // wrong here now that the address is typed rather than configured.
  const [confirming, setConfirming] = useState(false)
  const [preview, setPreview] = useState<SendPreview | null>(null)
  const [loadingPreview, setLoadingPreview] = useState(false)
  const [previewError, setPreviewError] = useState<string | null>(null)

  // 🔴 The SERVER refuses an unconfirmed send. This only stops somebody walking into a refusal
  // they could have been told about, and says the same thing the refusal would.
  const blockedReason = specConfirmed
    ? null
    : specSaved
      ? 'The specification is saved but not confirmed. Confirm it in step 1 above first. Until then the factory would get a sheet telling them not to build from it.'
      : 'Confirm the specification in step 1 above first. Until then the factory would get a sheet telling them not to build from it.'

  const sent = manufacturing.sentAt !== null
  const finished = manufacturing.finishedAt !== null

  /** Work out what would be sent, then show it. Nothing is claimed or posted. */
  function askToSend() {
    setConfirming(true)
    setPreview(null)
    setPreviewError(null)
    setLoadingPreview(true)
    void previewManufacturingPoSend({ manufacturing_po_id: poId })
      .then((res) => {
        if (res.ok) setPreview(res.preview)
        else setPreviewError(res.error)
      })
      .catch(() => setPreviewError('That could not be worked out. Please try again.'))
      .finally(() => setLoadingPreview(false))
  }

  function send() {
    startTransition(async () => {
      const res = await sendManufacturingPoToBamida({ manufacturing_po_id: poId })
      if (!res.ok) toast.error(res.error)
      else if (res.short) toast.warning(`${res.description}. They were told which materials are short.`)
      else toast.success(res.description)
      setConfirming(false)
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
          icon={<CheckCircle2 className="w-4 h-4" />}
          label="Confirmed by the factory"
          value={
            manufacturing.confirmedAt ? (
              <span className="text-gray-900">
                {date(manufacturing.confirmedAt)}
                {manufacturing.confirmedBy ? ` by ${manufacturing.confirmedBy}` : ''}
              </span>
            ) : sent ? (
              <span className="text-amber-700">waiting for them to confirm</span>
            ) : (
              <span className="text-gray-500">not yet</span>
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

      {canAct && !finished && !sent && (
        <div className="mt-5 rounded-lg border border-gray-200 bg-gray-50 px-4 py-3">
          <p className="text-xs font-medium uppercase tracking-wider text-gray-500">Goes to</p>
          <p className="mt-1 font-mono text-sm text-gray-900">{contact}</p>
          <p className="mt-1.5 text-xs text-gray-500">
            The manufacturer&apos;s point of contact. Not editable: one address receives the order,
            the low stock reminders and the chasing, so one person there is accountable for all of
            it. The confirmation dialog prints every address before anything is sent.
          </p>
        </div>
      )}

      {canAct && !finished && (
        <div className="mt-5 flex flex-wrap gap-2">
          {!sent && (
            <div>
              <button
                onClick={askToSend}
                disabled={pending || !specConfirmed}
                title={blockedReason ?? undefined}
                className="px-5 py-2 bg-echo-orange hover:bg-echo-orange-hover text-white text-sm font-medium rounded-lg disabled:opacity-50 transition-colors"
              >
                {pending ? 'Sending...' : 'Send to Bamida'}
              </button>
              {blockedReason && <p className="mt-2 text-xs text-amber-700">{blockedReason}</p>}
            </div>
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

      <SendConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        preview={preview}
        loading={loadingPreview}
        pending={pending}
        error={previewError}
        confirmLabel="Send it"
        onConfirm={send}
      />

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
