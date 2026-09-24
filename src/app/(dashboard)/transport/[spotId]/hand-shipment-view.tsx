import { notFound, redirect } from 'next/navigation'
import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'
import { depotsForOrg, transportSeesAll, type OrgCode } from '@/lib/organisations'
import type { CapabilityKey } from '@/lib/capabilities'
import { landedCostAllowed } from '@/lib/transport/cost-access'
import { loadLandedCost } from '@/lib/transport/landed-cost.server'
import { depotLabel } from '@/lib/depot-constants'
import { depotProducts, loadHubShipment } from '@/lib/transport/shipments.server'
import { SHIPMENT_DEPOTS, contentsSummary, handProgress, lineReferences, localOrderLabel } from '@/lib/transport/shipment'
import HandShipmentDetails from './hand-shipment-details'
import ShipmentContents from './shipment-contents'
import LandedCostCard from './landed-cost-card'

/**
 * A shipment kept by hand: one Cargo Partner has not booked, or that was booked some other way.
 *
 * Checked like every record page: one bound for a depot the caller's organisation does not hold is
 * not found, rather than hidden by a filter somebody could take off.
 */

function fullDate(iso: string | null): string {
  if (!iso) return '—'
  const [y, m, d] = iso.split('-')
  const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
  return `${Number(d)} ${months[Number(m) - 1] ?? m} ${y}`
}

export default async function HandShipmentView({
  id,
  org,
  who,
}: {
  id: string
  org: OrgCode
  who: { capabilities: ReadonlySet<CapabilityKey>; organisations: readonly OrgCode[] }
}) {
  const shipment = await loadHubShipment(id)
  if (!shipment) notFound()
  // Booked since: its page is the Cargo Partner one, which carries everything typed here.
  if (shipment.spotId) redirect(`/transport/${shipment.spotId}`)

  if (!transportSeesAll(org)) {
    const held = depotsForOrg(org)
    if (!shipment.depot || !held.includes(shipment.depot)) notFound()
  }

  const [products, landed] = await Promise.all([
    depotProducts(shipment.depot),
    landedCostAllowed(who, shipment.depot)
      ? loadLandedCost({
          hubId: shipment.id,
          spotId: null,
          depot: shipment.depot,
          containers: shipment.containers,
          lines: shipment.lines,
        })
      : Promise.resolve(null),
  ])
  const progress = handProgress(shipment)
  const depots = (transportSeesAll(org) ? [...SHIPMENT_DEPOTS] : depotsForOrg(org)).filter((d) =>
    (SHIPMENT_DEPOTS as readonly string[]).includes(d),
  )
  const title = shipment.containers.length
    ? shipment.containers.join(', ')
    : lineReferences(shipment.lines).join(', ') || 'A shipment kept by hand'

  return (
    <div className="p-6">
      <Link
        href="/transport"
        className="mb-4 inline-flex items-center gap-1.5 text-sm text-gray-500 transition-colors hover:text-gray-900"
      >
        <ArrowLeft className="h-4 w-4" /> All shipments
      </Link>

      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900" style={{ fontFamily: 'Varela Round, sans-serif' }}>
            {title}
          </h1>
          <p className="mt-1 text-sm text-gray-500">
            To {depotLabel(shipment.depot)} · kept by hand, not booked with Cargo Partner
            {contentsSummary(shipment.lines) ? ` · ${contentsSummary(shipment.lines)}` : ''}
          </p>
        </div>
        <div className="text-right">
          <p className="text-xs text-gray-500">{progress.isComplete ? 'Delivered' : 'Expected'}</p>
          <p className="text-lg font-semibold tabular-nums text-gray-900">{fullDate(progress.eta)}</p>
        </div>
      </div>

      <div
        className={`mb-5 rounded-xl border px-4 py-3 ${
          progress.isComplete ? 'border-emerald-200 bg-emerald-50' : 'border-gray-200 bg-gray-50'
        }`}
      >
        <p className="text-sm font-semibold text-gray-900">{progress.status}</p>
        {progress.on && <p className="mt-0.5 text-xs text-gray-600">on {fullDate(progress.on)}</p>}
      </div>

      <HandShipmentDetails shipment={shipment} depots={depots} />

      <ShipmentContents
        target={{ id: shipment.id }}
        depotName={depotLabel(shipment.depot)}
        localOrderLabel={localOrderLabel(shipment.depot)}
        lines={shipment.lines}
        products={products}
        fromSheet={[]}
      />

      {landed && <LandedCostCard target={{ id: shipment.id }} lines={shipment.lines} view={landed} />}
    </div>
  )
}
