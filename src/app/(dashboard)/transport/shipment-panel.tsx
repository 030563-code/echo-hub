'use client'

// page-state: none (a panel opened by clicking a row. It holds the fetched
// Cargo Partner detail for as long as it is open and nothing a person typed, so
// there is nothing to lose on navigation.)

import { useEffect, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { X, Loader2 } from 'lucide-react'
import StatusBadge from '@/components/board/StatusBadge'
import { formatDate } from '@/lib/utils'
import type { GroupedShipment } from '@/lib/shipment-grouping'
import { getShipmentDetail, type ShipmentDetailResult } from './actions'

/**
 * One shipment, opened from the board.
 *
 * The board rows carry what the Hub stored when the shipment was added; this
 * asks Cargo Partner what they know now. The two are shown separately on
 * purpose, because "what we recorded" and "where it actually is" are different
 * questions and a stale ETA next to a live one is the useful comparison.
 */
export default function ShipmentPanel({
  shipment,
  onClose,
}: {
  shipment: GroupedShipment
  onClose: () => void
}) {
  // One piece of state carrying WHICH shipment the answer is for, so loading is
  // derived rather than set. Setting a loading flag synchronously inside the
  // effect cascades renders, and a second flag can disagree with the first.
  const [live, setLive] = useState<{ spotId: string; result: ShipmentDetailResult } | null>(null)
  const loading = live?.spotId !== shipment.spotId
  const detail = loading ? null : live!.result

  useEffect(() => {
    let cancelled = false
    void (async () => {
      // Yield one macrotask before calling the Server Action. Calling one while
      // Next's Router is still committing a navigation makes the Router throw
      // "Rendered more hooks than during the previous render", which is
      // invisible in dev and leaves a blank page in production. Same guard as
      // hooks/use-page-state.ts.
      await new Promise((resolve) => setTimeout(resolve, 0))
      if (cancelled) return
      const result = await getShipmentDetail(shipment.spotId)
      if (cancelled) return
      setLive({ spotId: shipment.spotId, result })
    })()
    return () => {
      cancelled = true
    }
  }, [shipment.spotId])

  return (
    <Dialog.Root open onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/40 backdrop-blur-sm" />
        <Dialog.Content className="fixed right-0 top-0 z-50 flex h-full w-full max-w-xl flex-col border-l border-gray-200 bg-white shadow-2xl">
          <div className="flex items-start justify-between gap-4 border-b border-gray-200 px-6 py-4">
            <div className="min-w-0">
              <Dialog.Title
                className="truncate font-mono text-lg font-semibold text-echo-orange"
                style={{ fontFamily: 'Varela Round, sans-serif' }}
              >
                {shipment.spotId}
              </Dialog.Title>
              <p className="mt-0.5 truncate text-sm text-gray-600">
                {shipment.containerRef ?? 'container not recorded'}
                {shipment.depot ? ` to ${shipment.depot}` : ' (split across depots)'}
              </p>
            </div>
            <Dialog.Close className="rounded-lg p-1.5 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-900">
              <X className="h-4 w-4" />
            </Dialog.Close>
          </div>

          <div className="flex-1 space-y-6 overflow-y-auto px-6 py-5">
            {/* ---------- What the Hub recorded ---------- */}
            <section>
              <h3 className="text-xs font-medium uppercase tracking-wider text-gray-500">
                What we recorded
              </h3>
              <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                <Pair label="Status">
                  {shipment.status ? <StatusBadge dark={false} status={shipment.status} /> : <Dash />}
                </Pair>
                <Pair label="Units">
                  <span className="tabular-nums text-gray-900">{shipment.totalQty}</span>
                </Pair>
                <Pair label="Shipped">{formatDate(shipment.shippedAt) || <Dash />}</Pair>
                <Pair label="ETA">{formatDate(shipment.eta) || <Dash />}</Pair>
              </dl>
              {shipment.poReferences.length > 0 && (
                <p className="mt-2 text-sm text-gray-600">
                  Purchase orders:{' '}
                  <span className="font-mono text-gray-900">{shipment.poReferences.join(', ')}</span>
                </p>
              )}
            </section>

            {/* ---------- The contents ---------- */}
            <section>
              <h3 className="text-xs font-medium uppercase tracking-wider text-gray-500">
                On this shipment
              </h3>
              <div className="mt-2 overflow-hidden rounded-lg border border-gray-200">
                <table className="w-full text-sm">
                  <tbody>
                    {shipment.lines.map((l) => (
                      <tr key={l.id} className="border-b border-gray-100 last:border-0">
                        <td className="px-3 py-2 font-mono text-xs text-gray-900">{l.sku}</td>
                        <td className="px-3 py-2 text-gray-600">{l.product_name ?? ''}</td>
                        <td className="px-3 py-2 text-right tabular-nums text-gray-900">{l.qty}</td>
                        <td className="px-3 py-2 text-right font-mono text-xs text-gray-500">
                          {l.depot_destination ?? ''}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>

            {/* ---------- What Cargo Partner say now ---------- */}
            <section>
              <h3 className="text-xs font-medium uppercase tracking-wider text-gray-500">
                Cargo Partner, live
              </h3>

              {loading && (
                <p className="mt-2 flex items-center gap-2 text-sm text-gray-500">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" /> Asking Cargo Partner...
                </p>
              )}

              {!loading && !detail?.found && (
                <p className="mt-2 text-sm text-gray-500">
                  {detail?.error ?? 'Cargo Partner have nothing on this SPOT ID.'}
                </p>
              )}

              {!loading && detail?.found && (
                <>
                  <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                    <Pair label="Vessel">{detail.vessel || <Dash />}</Pair>
                    <Pair label="Carrier">{detail.carrier || <Dash />}</Pair>
                    <Pair label="Container">
                      <span className="font-mono text-xs text-gray-900">{detail.container_ref || '—'}</span>
                    </Pair>
                    <Pair label="Their ETA">{formatDate(detail.eta ?? null) || <Dash />}</Pair>
                  </dl>

                  {(detail.route?.length ?? 0) > 0 && (
                    <div className="mt-4">
                      <p className="text-xs font-medium text-gray-500">Route</p>
                      <ol className="mt-1.5 space-y-1 text-sm">
                        {detail.route!.map((p, i) => (
                          <li key={i} className="flex justify-between gap-3">
                            <span className="text-gray-900">{p.name ?? p.type}</span>
                            <span className="shrink-0 text-gray-500">
                              {p.estimatedArrival ? formatDate(p.estimatedArrival) : p.type}
                            </span>
                          </li>
                        ))}
                      </ol>
                    </div>
                  )}

                  {(detail.events?.length ?? 0) > 0 ? (
                    <div className="mt-4">
                      <p className="text-xs font-medium text-gray-500">Tracking</p>
                      <ol className="mt-1.5 space-y-1.5">
                        {detail.events!.map((e, i) => (
                          <li key={i} className="flex gap-3 text-sm">
                            <span className="w-24 shrink-0 tabular-nums text-gray-500">
                              {formatDate(e.date)}
                            </span>
                            <span className="text-gray-900">
                              {e.name}
                              {e.location ? <span className="text-gray-500"> at {e.location}</span> : null}
                            </span>
                          </li>
                        ))}
                      </ol>
                    </div>
                  ) : (
                    <p className="mt-4 text-sm text-gray-500">No tracking events yet.</p>
                  )}
                </>
              )}
            </section>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

function Pair({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-gray-500">{label}</dt>
      <dd className="mt-0.5 text-gray-900">{children}</dd>
    </div>
  )
}

const Dash = () => <span className="text-gray-400">{'—'}</span>
