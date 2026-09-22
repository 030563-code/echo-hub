import Link from 'next/link'
import { Check, Lock } from 'lucide-react'
import InfoHint from '@/components/ui/info-hint'

/**
 * The order of operations on a manufacturing order, said out loud.
 *
 * Dean, 17 Sep 2026: "what if they click on Manufacturing PO (PDF) see the spec is good then press
 * on send to bamida without going into Edit Specification first to save it. Then does it send with
 * that red line? there should really be steps to each of these. Like before seeing the
 * manufacturing and pricing PO they would first need to go through the specification and the
 * confirm or something more clear."
 *
 * It did send with the red line. The buttons were a pile with no order to them, so nothing said
 * that the specification comes first, and the send had no opinion about it either.
 *
 * 🔴 The real gate is in sendManufacturingPoToBamida, not here. This panel makes the sequence
 * visible; the server is what refuses. A panel that only greys a button would be bypassed by
 * anyone calling the action directly.
 */

type StepState = 'done' | 'now' | 'locked'

function Step({
  n,
  title,
  state,
  hint,
  children,
}: {
  n: number
  title: string
  state: StepState
  hint: string
  children: React.ReactNode
}) {
  const ring =
    state === 'done'
      ? 'bg-emerald-600 text-white'
      : state === 'now'
        ? 'bg-[#025945] text-white'
        : 'bg-gray-200 text-gray-500'

  return (
    <li className="flex gap-3">
      <span
        className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${ring}`}
        aria-hidden="true"
      >
        {state === 'done' ? (
          <Check className="h-3.5 w-3.5" />
        ) : state === 'locked' ? (
          <Lock className="h-3 w-3" />
        ) : (
          n
        )}
      </span>
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-1.5 text-sm font-medium text-gray-900">
          {title}
          <InfoHint label={`About step ${n}, ${title}`} align="left">
            {hint}
          </InfoHint>
        </p>
        <div className="mt-1.5">{children}</div>
      </div>
    </li>
  )
}

/** The -3 priced order's state, for the people who may see prices. Null hides the step. */
export interface PricedStep {
  canEdit: boolean
  saved: boolean
  confirmedAt: string | null
  confirmedBy: string | null
}

export default function ManufacturingSteps({
  poId,
  canEditSpec,
  specSaved,
  specConfirmedAt,
  specConfirmedBy,
  priced,
  sentAt,
  documents,
}: {
  poId: string
  canEditSpec: boolean
  specSaved: boolean
  specConfirmedAt: string | null
  specConfirmedBy: string | null
  /** Only for cost.view holders: every line on the priced order is a price. */
  priced: PricedStep | null
  sentAt: string | null
  /** The existing download buttons, passed in so this panel owns the order and not the wiring. */
  documents: React.ReactNode
}) {
  const confirmed = Boolean(specConfirmedAt)
  const sent = Boolean(sentAt)
  const date = (v: string | null) => (v ? new Date(v).toLocaleDateString('en-GB') : null)
  // The priced step sits between the specification and the documents, for those who see it.
  const documentsStep = priced ? 3 : 2
  const sendStep = priced ? 4 : 3

  return (
    <section className="rounded-xl border border-gray-200 bg-white p-5">
      <h2
        className="mb-1 flex items-center gap-1.5 text-base font-semibold text-gray-900"
        style={{ fontFamily: 'Varela Round, sans-serif' }}
      >
        Manufacturing order
        <InfoHint label="About this order" align="left">
          {priced ? 'Four' : 'Three'} steps, in order. The factory cannot be sent anything until the
          specification has been confirmed. The priced order is the accounting copy and is checked
          the same way.
        </InfoHint>
      </h2>
      <p className="mb-4 text-sm text-gray-500">
        Work down these. Each one unlocks the next.
      </p>

      <ol className="space-y-4">
        <Step
          n={1}
          title="Check the specification"
          state={confirmed ? 'done' : 'now'}
          hint="What the factory builds from: materials, colours, fabrics, pallets and packing. It is filled in for you from the order and the standing product specifications. Read it, change anything this order needs, then confirm it."
        >
          {confirmed ? (
            <p className="text-sm text-emerald-700">
              Confirmed{specConfirmedBy ? ` by ${specConfirmedBy}` : ''} on {date(specConfirmedAt)}.
            </p>
          ) : (
            <p className="text-sm text-amber-700">
              {specSaved
                ? 'Saved, but nobody has confirmed it. Nothing can be sent to the factory until somebody does.'
                : 'Not checked yet. Nothing can be sent to the factory until somebody confirms it.'}
            </p>
          )}
          <Link
            href={`/purchase-orders/${poId}/specification`}
            className="mt-2 inline-flex items-center rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50"
          >
            {canEditSpec ? 'Review specification' : 'View specification'}
          </Link>
        </Step>

        {priced && (
          <Step
            n={2}
            title="Check the priced order"
            state={priced.confirmedAt ? 'done' : 'now'}
            hint="The accounting copy: Bamida's prices per unit, the printing, the pallet covers and metal frames. It is filled in from the bill of materials and the confirmed specification. Change a price, add or remove a line, then confirm it. What you save is what the priced PDF prints."
          >
            {priced.confirmedAt ? (
              <p className="text-sm text-emerald-700">
                Confirmed{priced.confirmedBy ? ` by ${priced.confirmedBy}` : ''} on {date(priced.confirmedAt)}.
              </p>
            ) : (
              <p className="text-sm text-amber-700">
                {priced.saved
                  ? 'Saved, but nobody has confirmed it. The PDF prints the saved lines.'
                  : 'Not checked yet. The PDF prints the generated lines until somebody saves it.'}
              </p>
            )}
            <Link
              href={`/purchase-orders/${poId}/priced`}
              className="mt-2 inline-flex items-center rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50"
            >
              {priced.canEdit ? 'Review priced order' : 'View priced order'}
            </Link>
          </Step>
        )}

        <Step
          n={documentsStep}
          title="Download the documents"
          state={confirmed ? 'now' : 'locked'}
          hint="The manufacturing order is the specification with no prices on it, which is what the factory gets. The priced order is the accounting copy. The shipping order is the transport request, and it only exists once the barriers do."
        >
          {!confirmed && (
            <p className="mb-2 text-sm text-gray-500">
              You can download these now, but the manufacturing order is not the factory&apos;s
              until the specification is confirmed and sent.
            </p>
          )}
          {documents}
        </Step>

        <Step
          n={sendStep}
          title="Send to the factory"
          state={sent ? 'done' : confirmed ? 'now' : 'locked'}
          hint="Emails the factory to say an order is waiting and links them into the Hub, where they download it, confirm it with their dates and mark it finished. No PDF is attached to that email."
        >
          {sent ? (
            <p className="text-sm text-emerald-700">Sent on {date(sentAt)}.</p>
          ) : confirmed ? (
            <p className="text-sm text-gray-600">
              Ready. The send button is on the Manufacturing card below, with the addresses it will
              go to.
            </p>
          ) : (
            <p className="text-sm text-gray-500">
              Locked until the specification is confirmed. The send is refused by the server, not
              only hidden here.
            </p>
          )}
        </Step>
      </ol>
    </section>
  )
}
