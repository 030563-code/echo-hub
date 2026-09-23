import { notFound, redirect } from 'next/navigation'
import Link from 'next/link'
import { ArrowLeft, AlertTriangle } from 'lucide-react'
import { getAuthorizedUser } from '@/lib/authz'
import { activeOrganisation } from '@/lib/active-organisation.server'
import { depotsForOrg, transportSeesAll } from '@/lib/organisations'
import { depotLabel } from '@/lib/depot-constants'
import { loadCargoShipment } from '@/lib/cargo/store'
import { listCargoShareLinks } from '@/app/actions/cargo/share-link'
import CargoTimeline from '@/components/cargo/cargo-timeline'
import ShareLinkCard from './share-link-card'
import CargoEventList from './cargo-event-list'
import { CustomsCard } from './customs-card'

/**
 * One container: where it is, how it got there, and a link to send somebody.
 *
 * The record page checks the record, the way every other record page in the Hub
 * does: a shipment bound for a depot the caller's organisation does not hold is
 * not found, rather than hidden by a filter somebody could take off.
 */

export const dynamic = 'force-dynamic'

function fullDate(iso: string | null): string {
  if (!iso) return '—'
  const [y, m, d] = iso.split('-')
  const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
  return `${Number(d)} ${months[Number(m) - 1] ?? m} ${y}`
}

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-gray-500">{label}</dt>
      <dd className="mt-0.5 text-sm text-gray-900">{value || '—'}</dd>
    </div>
  )
}

export default async function CargoShipmentPage({ params }: { params: Promise<{ spotId: string }> }) {
  const { spotId } = await params
  const auth = await getAuthorizedUser()
  if (!auth.ok) redirect('/')

  const org = await activeOrganisation(auth)
  if (!org) redirect('/transport')

  const today = new Date().toISOString().slice(0, 10)
  const shipment = await loadCargoShipment(spotId, today)
  if (!shipment) notFound()

  // The record's own organisation, checked against what the caller holds.
  if (!transportSeesAll(org)) {
    const held = depotsForOrg(org)
    if (!shipment.destinationDepot || !held.includes(shipment.destinationDepot)) notFound()
  }

  const links = await listCargoShareLinks(spotId)
  const late = shipment.slipDays != null && shipment.slipDays >= 1

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
            {shipment.containers.length
              ? shipment.containers.map((c) => c.number).join(', ')
              : `SPOT ${shipment.spotId}`}
          </h1>
          <p className="mt-1 text-sm text-gray-500">
            {shipment.originCity ?? '—'} to {shipment.destinationCity ?? '—'}
            {shipment.destinationDepot ? ` · ${depotLabel(shipment.destinationDepot)}` : ''}
            {shipment.generalReference ? ` · ${shipment.generalReference}` : ''}
          </p>
        </div>
        <div className="text-right">
          <p className="text-xs text-gray-500">{shipment.isComplete ? 'Arrived' : 'Expected'}</p>
          <p className="text-lg font-semibold tabular-nums text-gray-900">{fullDate(shipment.eta)}</p>
        </div>
      </div>

      {/* Where it is, said once, in words. */}
      <div
        className={`mb-5 rounded-xl border px-4 py-3 ${
          shipment.isComplete ? 'border-emerald-200 bg-emerald-50' : 'border-[#025945]/20 bg-[#025945]/5'
        }`}
      >
        <p className="text-sm font-semibold text-gray-900">
          {shipment.currentStatus ?? 'Nothing has been reported yet'}
          {shipment.currentStatusLocation ? ` at ${shipment.currentStatusLocation}` : ''}
        </p>
        {shipment.currentStatusOn && (
          <p className="mt-0.5 text-xs text-gray-600">as at {fullDate(shipment.currentStatusOn)}</p>
        )}
      </div>

      {late && (
        <div className="mb-5 flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
          <p className="text-sm text-amber-900">
            The forwarder has moved this schedule by {shipment.slipDays} days in total since the first plan.
            Every change is listed under the milestones below.
          </p>
        </div>
      )}

      <section className="mb-5 rounded-xl border border-gray-200 bg-white p-5">
        <h2 className="mb-4 text-base font-semibold text-gray-900" style={{ fontFamily: 'Varela Round, sans-serif' }}>
          Route
        </h2>
        <CargoTimeline stops={shipment.timeline} today={today} />
      </section>

      <div className="grid gap-5 lg:grid-cols-3">
        <section className="rounded-xl border border-gray-200 bg-white p-5 lg:col-span-2">
          <h2 className="mb-4 text-base font-semibold text-gray-900" style={{ fontFamily: 'Varela Round, sans-serif' }}>
            Shipment
          </h2>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-3">
            <Field label="SPOT ID" value={<span className="tabular-nums">{shipment.spotId}</span>} />
            <Field label="Vessel" value={shipment.vesselName} />
            <Field label="Voyage" value={shipment.voyageNumber} />
            <Field label="Carrier" value={shipment.oceanCarrier} />
            <Field label="Master bill of lading" value={shipment.mbl} />
            <Field label="House bill of lading" value={shipment.hbl} />
            <Field label="Cargo" value={shipment.cargoDescription} />
            <Field label="Pieces" value={shipment.totalPieces?.toLocaleString('en-GB')} />
            <Field
              label="Weight"
              value={shipment.totalWeight ? `${shipment.totalWeight.toLocaleString('en-GB')} kg` : null}
            />
            <Field
              label="Volume"
              value={shipment.totalVolume ? `${shipment.totalVolume.toLocaleString('en-GB')} m³` : null}
            />
            <Field label="Shipper" value={shipment.shipperName} />
            <Field label="Consignee" value={shipment.consigneeName} />
          </dl>

          {shipment.containers.length > 0 && (
            <div className="mt-5 border-t border-gray-100 pt-4">
              <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-400">
                {shipment.containers.length === 1 ? 'Container' : 'Containers'}
              </p>
              <ul className="space-y-1">
                {shipment.containers.map((c) => (
                  <li key={c.number} className="text-sm text-gray-700">
                    <span className="font-medium tabular-nums text-gray-900">{c.number}</span>
                    {c.code ? ` · ${c.code}` : ''}
                    {c.seal ? ` · seal ${c.seal}` : ''}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>

        <ShareLinkCard
          spotId={shipment.spotId}
          initialLinks={links.ok ? links.links : []}
          canShare={links.ok}
        />
      </div>

      {auth.capabilities.has('customs.manage') && (
        <CustomsCard
          spotId={shipment.spotId}
          destinationCountry={shipment.destinationCountry}
          originCountry={shipment.originCountry}
          goodsValue={shipment.goodsValue}
          currencyCode={shipment.currencyCode}
          eta={shipment.eta}
          today={today}
        />
      )}

      <section className="mt-5 rounded-xl border border-gray-200 bg-white p-5">
        <h2 className="mb-1 text-base font-semibold text-gray-900" style={{ fontFamily: 'Varela Round, sans-serif' }}>
          Milestones
        </h2>
        <p className="mb-4 text-sm text-gray-500">
          Everything the forwarder has reported, newest first. A forecast is shown in grey.
        </p>
        <CargoEventList events={shipment.events} today={today} />
      </section>
    </div>
  )
}
