'use client'

// page-state: none (open/closed and the preview it is showing. Both are gone the
// moment the dialog closes, and the durable record is written by the send.)

import { AlertTriangle, Loader2, Mail } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { ConfirmPanel } from '@/components/ui/confirm-panel'
import { ORIGIN_LABELS, type PreviewAddress, type SendPreview } from '@/lib/send-preview'

/**
 * The question asked before an email leaves the building.
 *
 * Dean, 16 Sep 2026: "add second confirmation before sending to Manufacturing on
 * the email and the contents of the email as well as confirmation before sending
 * to Cargo partner along with CC everything and where it comes from."
 *
 * Both sends it guards email an outside company and neither asked anything
 * before: on the manufacturing card the only dialog guarded reopening an order,
 * which is harmless, and the shipment request went to the forwarder on one
 * click and cannot be recalled.
 *
 * It prints EVERY address, including the ones nobody typed. A blind copy set on
 * the server appears on no screen in the Hub, so this is the only place a person
 * can find out it exists, and each address says where to go and change it.
 *
 * The wording of the email itself belongs to n8n and is not reproduced here.
 * What this shows is the Hub's half: who it goes to and what it carries.
 */
export default function SendConfirmDialog({
  open,
  onOpenChange,
  preview,
  loading,
  pending,
  error,
  confirmLabel,
  onConfirm,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  preview: SendPreview | null
  /** Working out what would be sent. */
  loading: boolean
  /** The send itself is running. */
  pending: boolean
  error: string | null
  confirmLabel: string
  onConfirm: () => void
}) {
  return (
    <Dialog open={open} onOpenChange={(next) => !pending && onOpenChange(next)}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Mail className="w-4 h-4 text-gray-400 shrink-0" />
            {preview ? `Send ${preview.what}?` : 'Send this?'}
          </DialogTitle>
          <DialogDescription>
            Nothing has been sent yet. Check who receives this and what it says.
          </DialogDescription>
        </DialogHeader>

        {loading && (
          <p className="flex items-center gap-2 text-sm text-gray-500">
            <Loader2 className="w-4 h-4 animate-spin" />
            Working out what would be sent...
          </p>
        )}

        {error && !loading && (
          <p className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</p>
        )}

        {preview && !loading && (
          <div className="space-y-5">
            {preview.isTest && (
              <ConfirmPanel>
                <p className="font-medium text-gray-900">This will not reach them.</p>
                <p className="mt-1">
                  The Hub is diverting every email to the test address. It would otherwise have gone
                  to {preview.instead?.to.join(', ') || 'nobody'}
                  {preview.instead?.cc.length ? `, copy ${preview.instead.cc.join(', ')}` : ''}.
                </p>
              </ConfirmPanel>
            )}

            <section>
              <h3 className="text-xs font-medium uppercase tracking-wider text-gray-500">Who gets it</h3>
              <dl className="mt-2 space-y-2">
                <AddressRow label="To" addresses={preview.to} emptyNote="nobody" />
                <AddressRow label="Copy" addresses={preview.cc} emptyNote="nobody" />
                <AddressRow label="Blind copy" addresses={preview.bcc} emptyNote={null} />
              </dl>
            </section>

            <section>
              <h3 className="text-xs font-medium uppercase tracking-wider text-gray-500">
                What it carries
              </h3>
              <dl className="mt-2 grid grid-cols-1 gap-x-6 gap-y-1.5 sm:grid-cols-2">
                {preview.facts.map((fact) => (
                  <div
                    key={fact.label}
                    className={`flex gap-2 text-sm${fact.wide ? ' sm:col-span-2' : ''}`}
                  >
                    <dt className="shrink-0 text-gray-500">{fact.label}</dt>
                    <dd className="min-w-0 break-words text-gray-900">{fact.value}</dd>
                  </div>
                ))}
              </dl>

              {preview.lines.length > 0 && (
                <ul className="mt-3 divide-y divide-gray-100 rounded-lg border border-gray-200">
                  {preview.lines.map((line, i) => (
                    <li
                      key={`${line.name}-${i}`}
                      className="flex items-baseline justify-between gap-4 px-3 py-1.5 text-sm"
                    >
                      <span className="min-w-0 break-words text-gray-900">{line.name}</span>
                      <span className="shrink-0 tabular-nums text-gray-500">{line.quantity}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            {preview.warnings.length > 0 && (
              <ul className="space-y-1.5">
                {preview.warnings.map((warning) => (
                  <li key={warning} className="flex items-start gap-2 text-sm text-amber-700">
                    <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
                    <span>{warning}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        <DialogFooter className="gap-2">
          <button
            onClick={() => onOpenChange(false)}
            disabled={pending}
            className="px-4 py-2 text-sm rounded-lg border border-gray-300 text-gray-700 hover:text-gray-900 hover:bg-gray-100 disabled:opacity-50 transition-colors"
          >
            Not yet
          </button>
          <button
            onClick={onConfirm}
            disabled={pending || loading || !preview}
            className="px-5 py-2 bg-echo-orange hover:bg-echo-orange-hover text-white text-sm font-medium rounded-lg disabled:opacity-50 transition-colors"
          >
            {pending ? 'Sending...' : confirmLabel}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/**
 * One line of the audience. The origin is shown against every address, not once
 * per row, because a row can mix an address somebody typed with one the server
 * added.
 */
function AddressRow({
  label,
  addresses,
  emptyNote,
}: {
  label: string
  addresses: PreviewAddress[]
  /** What to print when there are none. Null hides the row entirely. */
  emptyNote: string | null
}) {
  if (addresses.length === 0 && emptyNote === null) return null

  return (
    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-sm">
      <dt className="w-20 shrink-0 text-gray-500">{label}</dt>
      <dd className="min-w-0 flex-1">
        {addresses.length === 0 ? (
          <span className="text-gray-400">{emptyNote}</span>
        ) : (
          <ul className="space-y-1">
            {addresses.map((entry) => (
              <li key={`${entry.address}-${entry.from}`} className="flex flex-wrap items-baseline gap-2">
                <span className="break-all text-gray-900">{entry.address}</span>
                <span
                  className={
                    entry.origin === 'test-override'
                      ? 'rounded bg-echo-yellow/20 px-1.5 py-0.5 text-xs text-amber-700'
                      : 'rounded bg-gray-100 px-1.5 py-0.5 text-xs text-gray-500'
                  }
                >
                  {ORIGIN_LABELS[entry.origin]}: {entry.from}
                </span>
              </li>
            ))}
          </ul>
        )}
      </dd>
    </div>
  )
}
