import type { ShipmentContent } from '@/lib/erp-types'

/**
 * One row per shipment, not one per SKU line.
 *
 * shipment_contents holds a line per product in a container, so a container of
 * four models filled four rows of the board with the same SPOT ID, the same
 * container, the same ETA and the same status. Reading it meant recognising
 * that four rows were one thing.
 *
 * Pure, so the grouping rules can be tested without a database or a browser.
 */

export interface GroupedShipment {
  spotId: string
  containerRef: string | null
  /** Depot when every line agrees, null when a container is split. */
  depot: string | null
  /** The least-advanced status in the container: a shipment is only as far as its slowest line. */
  status: string | null
  shippedAt: string | null
  /** The earliest ETA on any line. */
  eta: string | null
  /** Every distinct PO on the container. The old board dropped all but the first. */
  poReferences: string[]
  totalQty: number
  lines: ShipmentContent[]
}

/**
 * How far along a shipment is. The container's own status is the least
 * advanced line, because a container is not at the port while part of it is
 * still on the water.
 */
const STATUS_ORDER = ['on_water', 'at_port', 'customs', 'delivered'] as const

function statusRank(status: string | null | undefined): number {
  const i = STATUS_ORDER.indexOf(String(status ?? '') as (typeof STATUS_ORDER)[number])
  return i === -1 ? STATUS_ORDER.length : i
}

/** Earliest non-empty date, or null. */
function earliest(dates: Array<string | null | undefined>): string | null {
  const real = dates.map((d) => String(d ?? '').trim()).filter(Boolean).sort()
  return real[0] ?? null
}

export function groupBySpotId(items: readonly ShipmentContent[]): GroupedShipment[] {
  const bySpot = new Map<string, ShipmentContent[]>()
  for (const item of items) {
    const key = String(item.spot_id ?? '').trim() || '(no SPOT ID)'
    const list = bySpot.get(key)
    if (list) list.push(item)
    else bySpot.set(key, [item])
  }

  const grouped: GroupedShipment[] = []
  for (const [spotId, lines] of bySpot) {
    const depots = new Set(lines.map((l) => String(l.depot_destination ?? '').trim()).filter(Boolean))
    const containers = new Set(lines.map((l) => String(l.container_ref ?? '').trim()).filter(Boolean))

    // A comma-joined po_reference is how the old data recorded a multi-PO
    // container, and shipment_contents.po_reference matching dropped all but
    // the first. Split it, so every PO on the container is visible.
    const poReferences = Array.from(
      new Set(
        lines
          .flatMap((l) => String(l.po_reference ?? '').split(','))
          .map((r) => r.trim())
          .filter(Boolean),
      ),
    ).sort()

    grouped.push({
      spotId,
      containerRef: containers.size === 1 ? [...containers][0] : null,
      depot: depots.size === 1 ? [...depots][0] : null,
      status: lines.reduce<string | null>(
        (worst, l) => (worst === null || statusRank(l.status) < statusRank(worst) ? l.status : worst),
        null,
      ),
      shippedAt: earliest(lines.map((l) => l.shipped_at)),
      eta: earliest(lines.map((l) => l.eta)),
      poReferences,
      totalQty: lines.reduce((sum, l) => sum + Number(l.qty ?? 0), 0),
      lines,
    })
  }

  // Soonest arrival first, then by SPOT ID so the order never wobbles between
  // refreshes. A shipment with no ETA sorts last: it is the least urgent thing
  // to look at, not the most.
  return grouped.sort((a, b) => {
    if (a.eta && b.eta && a.eta !== b.eta) return a.eta.localeCompare(b.eta)
    if (a.eta && !b.eta) return -1
    if (!a.eta && b.eta) return 1
    return a.spotId.localeCompare(b.spotId, undefined, { numeric: true })
  })
}
