import { redirect } from 'next/navigation'
import { getAuthorizedUser } from '@/lib/authz'
import { activeOrganisation } from '@/lib/active-organisation.server'
import { depotsForOrg, transportSeesAll } from '@/lib/organisations'
import { NoOrganisationCard } from '@/components/organisations/no-organisation-card'
import { loadCargoBoard } from '@/lib/cargo/store'
import { loadHubBoard } from '@/lib/transport/shipments.server'
import { boardItems } from '@/lib/transport/board'
import { SHIPMENT_DEPOTS } from '@/lib/transport/shipment'
import CargoBoard from './cargo-board'

/**
 * Logistics and Shipping: where every container actually is.
 *
 * Dean, 22 Sep 2026: "Create a visual representation of cargo currently in
 * transit, showing its status."
 *
 * WHAT THIS REPLACED. The page read public.shipment_contents, eleven rows that
 * somebody typed in by hand and that all say "delivered". The live position of
 * every container was already in the database, in a table the Hub never opened,
 * refreshed each morning by Dave's n8n workflow. So the screen showed eleven
 * finished shipments while three containers were on the water.
 *
 * Scope is in the query, not in a check. Every container leaves s.r.o. and
 * belongs to Group on the way, so those two see all of them; a depot's
 * organisation sees what is bound for its own depots.
 *
 * Dean, 24 Sep 2026: shipments not booked with Cargo Partner are kept by hand
 * beside them, under the same scope, so Dave's sheet is no longer the only
 * place they live.
 */

export const dynamic = 'force-dynamic'

export default async function TransportPage() {
  const auth = await getAuthorizedUser()
  if (!auth.ok) redirect('/')

  const org = await activeOrganisation(auth)
  if (!org) return <NoOrganisationCard title="Logistics & Shipping" what="shipments" />

  const depots = transportSeesAll(org) ? null : depotsForOrg(org)
  const booked = await loadCargoBoard(depots)
  const { hand, linesBySpot } = await loadHubBoard(depots, booked.map((r) => r.spotId))
  const rows = boardItems(booked, linesBySpot, hand)
  const today = new Date().toISOString().slice(0, 10)
  // Where this organisation may keep a shipment by hand: its own depots, or any of them for the
  // two organisations every container passes through.
  const handDepots = (depots ?? SHIPMENT_DEPOTS).filter((d) => (SHIPMENT_DEPOTS as readonly string[]).includes(d))

  const inTransit = rows.filter((r) => !r.isComplete)
  const onWater = inTransit.filter((r) => r.departedOn && !r.currentStatus?.startsWith('Unloaded')).length
  // Slipped against the forwarder's own first plan, which is the number that
  // makes somebody pick up the phone.
  const slipping = inTransit.filter((r) => (r.slipDays ?? 0) >= 1).length
  const pieces = inTransit.reduce((sum, r) => sum + (r.totalPieces ?? 0), 0)

  return (
    <div className="p-6">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900" style={{ fontFamily: 'Varela Round, sans-serif' }}>
          Logistics &amp; Shipping
        </h1>
        <p className="mt-1 text-sm text-gray-500">
          Live from Cargo Partner, with the shipments not booked yet kept by hand. Open one to see what is on it.
        </p>
      </div>

      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[
          { label: 'In transit', value: inTransit.length, color: 'text-gray-900' },
          { label: 'Sailed', value: onWater, color: 'text-blue-700' },
          { label: 'Running late', value: slipping, color: slipping ? 'text-amber-700' : 'text-gray-900' },
          { label: 'Pieces in transit', value: pieces, color: 'text-echo-orange' },
        ].map(({ label, value, color }) => (
          <div key={label} className="rounded-lg border border-gray-200 bg-white px-4 py-3">
            <p className="mb-0.5 text-xs text-gray-500">{label}</p>
            <p className={`text-2xl font-bold tabular-nums ${color}`}>{value}</p>
          </div>
        ))}
      </div>

      <CargoBoard rows={rows} today={today} handDepots={handDepots} />
    </div>
  )
}
