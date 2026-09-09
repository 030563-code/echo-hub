'use client'

// page-state: none (a busy flag only. The durable value is
// purchase_orders.lifecycle_stage, written by the action on every click.)

import { useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { setPoStage } from '@/app/actions/purchase-orders/set-po-stage'
import { LIFECYCLE_STAGES, stageLabel, type LifecycleStage } from '@/lib/po-lifecycle'

/**
 * Which board column this order sits in.
 *
 * Deliberately labelled as board placement rather than status, because that is
 * what it is: `lifecycle_stage` is presentation only and never touches the
 * status machine. Until now the only way to move a card was to drag it on the
 * board, which the emailed link does not take you to.
 *
 * There is no "back to automatic" option. The stage is derived from leg and
 * status until somebody sets it, and `set_po_lifecycle_stage` refuses null, so
 * an option to clear it would only ever produce an error.
 */
export default function StageControl({
  poId,
  current,
  derived,
  canMove,
}: {
  poId: string
  /** The stage in force, whether stored or derived. */
  current: LifecycleStage
  /** Where leg and status would put it on their own. */
  derived: LifecycleStage
  canMove: boolean
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()

  if (!canMove) {
    return (
      <span className="text-sm text-gray-600">
        Board column: <span className="text-gray-900">{stageLabel(current)}</span>
      </span>
    )
  }

  function move(stage: LifecycleStage) {
    if (stage === current) return
    startTransition(async () => {
      const res = await setPoStage({ poId, stage })
      if (!res.success) toast.error(res.error)
      else toast.success(`Moved to ${stageLabel(stage)}.`)
      router.refresh()
    })
  }

  return (
    <div>
      <p className="text-xs font-medium uppercase tracking-wider text-gray-500 mb-1.5">
        Board column
      </p>
      <div className="flex flex-wrap gap-1.5">
        {LIFECYCLE_STAGES.map((stage) => (
          <button
            key={stage.key}
            onClick={() => move(stage.key)}
            disabled={pending}
            className={
              stage.key === current
                ? 'px-3 py-1.5 text-xs rounded-lg bg-echo-orange text-white font-medium disabled:opacity-50 transition-colors'
                : 'px-3 py-1.5 text-xs rounded-lg border border-gray-300 text-gray-700 hover:text-gray-900 hover:bg-gray-100 disabled:opacity-50 transition-colors'
            }
          >
            {stage.label}
          </button>
        ))}
      </div>
      <p className="mt-1.5 text-xs text-gray-400">
        Where this order shows on the board. It does not change the order&apos;s status.
        {current === derived ? ' Following leg and status.' : ` Leg and status alone would put it in ${stageLabel(derived)}.`}
      </p>
    </div>
  )
}
