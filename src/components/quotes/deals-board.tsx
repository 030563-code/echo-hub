'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'
import Link from 'next/link'
import { MoveRight } from 'lucide-react'
import { formatMoney, formatRelative } from '@/lib/utils'
import { ownerLabel, teamLabel, type OwnerIndex } from '@/lib/hubspot-owners'
import { isClosedStage } from '@/lib/deals-board'
import type { BoardColumn } from '@/lib/deals-board'
import type { HubSpotDeal } from '@/lib/hubspot-types'

/**
 * The deals board, one column per real HubSpot stage.
 *
 * Dean asked to replicate the kanban "similar to the Purchase order style".
 * The layout follows that board (horizontal scroll, fixed column width, a count
 * pill in each header) but in the Quotes module's light theme rather than the
 * PO board's dark surface, because this is a rep-facing screen.
 *
 * A drop does not write anything by itself. It navigates to the deal with the
 * target stage preselected, so the existing change-stage dialog runs with every
 * guard it already has: the depot rule at Quotation Accepted, the US delivery
 * address, the tender date. A board that PATCHed HubSpot directly would be a
 * second write path with none of that.
 *
 * Native drag events, no library. They do not fire on touch, which is why every
 * card also carries a Move control: phones are a first-class case here.
 */

export function DealsBoard({
  groups,
  owners,
  showOwner,
}: {
  groups: { column: BoardColumn; deals: HubSpotDeal[] }[]
  owners?: OwnerIndex
  showOwner: boolean
}) {
  const router = useRouter()
  const [dragging, setDragging] = useState<string | null>(null)
  const [over, setOver] = useState<string | null>(null)

  function move(dealId: string, stageId: string) {
    if (!stageId) return
    router.push(`/quotes/deals/${dealId}?stage=${encodeURIComponent(stageId)}`)
  }

  return (
    <div className="flex gap-3 overflow-x-auto pb-4">
      {groups.map(({ column, deals }) => {
        const closed = isClosedStage(column.stageId)
        return (
          <div
            key={column.stageId || column.stageKey}
            onDragOver={(e) => {
              // Without preventDefault the drop never fires at all.
              if (!column.stageId) return
              e.preventDefault()
              setOver(column.stageId)
            }}
            onDragLeave={() => setOver((current) => (current === column.stageId ? null : current))}
            onDrop={(e) => {
              e.preventDefault()
              setOver(null)
              const dealId = e.dataTransfer.getData('text/plain') || dragging
              if (dealId && column.stageId) move(dealId, column.stageId)
            }}
            className={`w-72 shrink-0 rounded-lg border ${
              over === column.stageId
                ? 'border-echo-yellow bg-yellow-50'
                : closed
                  ? 'border-gray-200 bg-gray-100'
                  : 'border-gray-200 bg-gray-50'
            }`}
          >
            <div className="flex items-center justify-between border-b border-gray-200 px-3 py-2">
              {/* A heading, not a span: it names a region of the board, and
                  it is how a screen reader (and a test) tells a column apart
                  from the Move menu that repeats the same stage names. */}
              <h2 className={`text-sm font-semibold ${closed ? 'text-gray-500' : 'text-gray-900'}`}>
                {column.label}
              </h2>
              <span className="rounded-full bg-white px-2 py-0.5 text-xs text-gray-600">{deals.length}</span>
            </div>

            <div className="space-y-2 p-2">
              {deals.length === 0 ? (
                <p className="rounded border border-dashed border-gray-300 px-3 py-6 text-center text-xs text-gray-400">
                  Nothing here
                </p>
              ) : (
                deals.map((deal) => (
                  <div
                    key={deal.id}
                    draggable
                    onDragStart={(e) => {
                      e.dataTransfer.setData('text/plain', deal.id)
                      e.dataTransfer.effectAllowed = 'move'
                      setDragging(deal.id)
                    }}
                    onDragEnd={() => setDragging(null)}
                    className={`rounded border border-gray-200 bg-white p-3 shadow-sm transition ${
                      dragging === deal.id ? 'opacity-50' : 'hover:border-gray-300'
                    }`}
                  >
                    <Link href={`/quotes/deals/${deal.id}`} className="block">
                      <p className="text-sm font-medium text-gray-900 break-words">
                        {deal.properties.dealname}
                      </p>
                      <p className="mt-1 font-mono text-sm text-gray-700">
                        {deal.properties.amount
                          ? formatMoney(Number(deal.properties.amount), deal.properties.deal_currency_code ?? 'USD')
                          : '—'}
                      </p>
                      <p className="mt-1 text-xs text-gray-400">
                        {formatRelative(deal.properties.createdate)}
                      </p>
                      {showOwner && owners && (
                        <p className="mt-1 text-xs text-gray-500">
                          {ownerLabel(owners, deal.properties.hubspot_owner_id)}
                          <span className="block text-gray-400">
                            {teamLabel(owners, deal.properties.hubspot_team_id, deal.properties.hubspot_owner_id)}
                          </span>
                        </p>
                      )}
                    </Link>

                    {/* Drag does not exist on touch, so the same journey has a
                        button. Both land on the deal with the stage chosen. */}
                    <details className="mt-2">
                      <summary className="flex cursor-pointer list-none items-center gap-1 text-xs text-gray-500 hover:text-gray-800">
                        <MoveRight className="h-3.5 w-3.5" />
                        Move
                      </summary>
                      <ul className="mt-1 max-h-40 overflow-y-auto rounded border border-gray-200 bg-white">
                        {groups
                          .filter((g) => g.column.stageId && g.column.stageId !== deal.properties.dealstage)
                          .map((g) => (
                            <li key={g.column.stageId}>
                              <button
                                type="button"
                                onClick={() => move(deal.id, g.column.stageId)}
                                className="block w-full px-2 py-1.5 text-left text-xs text-gray-700 hover:bg-gray-50"
                              >
                                {g.column.label}
                              </button>
                            </li>
                          ))}
                      </ul>
                    </details>
                  </div>
                ))
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}
