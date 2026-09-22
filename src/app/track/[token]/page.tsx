import { createAdminClient } from '@/lib/supabase/admin'
import { loadCargoShipment, toPublicView, type CargoPublicView } from '@/lib/cargo/store'
import CargoTimeline from '@/components/cargo/cargo-timeline'

/**
 * What a customer sees when they open the link we sent them.
 *
 * NO SESSION. This route is exempt in the middleware, so the only thing between
 * the internet and this page is the token in the URL, which is 32 random bytes.
 *
 * 🔴 WHAT IS NOT ON THIS PAGE, and why each one is missing. The goods value and
 * the currency, because that is what we paid and not what they paid. The weight
 * and the volume, because that is what we declared. The shipper and consignee
 * legal names and the bills of lading, because those are our paperwork with the
 * forwarder. The SPOT ID, so nobody can walk the forwarder's own numbering. And
 * the label we typed when we made the link, because that is our note about them.
 *
 * The whitelist that enforces it is toPublicView in src/lib/cargo/store.ts, and
 * it is a whitelist rather than a delete list on purpose: a field added to the
 * shipment later is invisible here until somebody decides it should not be.
 */

export const dynamic = 'force-dynamic'

function fullDate(iso: string | null): string {
  if (!iso) return 'not yet known'
  const [y, m, d] = iso.split('-')
  const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
  return `${Number(d)} ${months[Number(m) - 1] ?? m} ${y}`
}

function Gone({ message }: { message: string }) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-gray-50 p-6">
      <div className="w-full max-w-md rounded-xl border border-gray-200 bg-white p-8 text-center">
        <h1 className="text-lg font-semibold text-gray-900" style={{ fontFamily: 'Varela Round, sans-serif' }}>
          This tracking link is not available
        </h1>
        <p className="mt-2 text-sm text-gray-500">{message}</p>
        <p className="mt-6 text-xs text-gray-400">Echo Barrier</p>
      </div>
    </main>
  )
}

/**
 * Resolve the token. A revoked link, an expired link and a token that was never
 * real all give the SAME answer, so nobody can tell a wrong guess from a link
 * that used to work.
 */
async function resolve(token: string): Promise<CargoPublicView | null> {
  if (!token || token.length < 32 || token.length > 200) return null

  const admin = createAdminClient()
  const { data } = await admin
    .from('cargo_share_link')
    .select('token, spot_id, expires_at, revoked_at, view_count')
    .eq('token', token)
    .maybeSingle()
  if (!data) return null

  const link = data as { spot_id: string; expires_at: string | null; revoked_at: string | null; view_count: number }
  if (link.revoked_at) return null
  if (link.expires_at && Date.parse(link.expires_at) < Date.now()) return null

  const today = new Date().toISOString().slice(0, 10)
  const shipment = await loadCargoShipment(link.spot_id, today)
  if (!shipment) return null

  // Enough to answer "did they ever open it" without tracking a person.
  await admin
    .from('cargo_share_link')
    .update({ last_viewed_at: new Date().toISOString(), view_count: (link.view_count ?? 0) + 1 })
    .eq('token', token)

  return toPublicView(shipment, today)
}

export default async function TrackPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  const view = await resolve(token)
  if (!view) {
    return <Gone message="It may have expired or been withdrawn. Ask your Echo Barrier contact for a new one." />
  }

  const today = new Date().toISOString().slice(0, 10)

  return (
    <main className="min-h-screen bg-gray-50 px-4 py-10">
      <div className="mx-auto w-full max-w-3xl">
        <header className="mb-6">
          <p className="text-xs font-semibold uppercase tracking-wide text-gray-400">Echo Barrier</p>
          <h1 className="mt-1 text-2xl font-bold text-gray-900" style={{ fontFamily: 'Varela Round, sans-serif' }}>
            Shipment tracking
          </h1>
          <p className="mt-1 text-sm text-gray-500">
            {view.containerNumbers.length
              ? `Container ${view.containerNumbers.join(', ')}`
              : 'Your shipment'}
            {view.reference ? ` · ${view.reference}` : ''}
          </p>
        </header>

        <section
          className={`mb-5 rounded-xl border px-5 py-4 ${
            view.isComplete ? 'border-emerald-200 bg-emerald-50' : 'border-[#025945]/20 bg-white'
          }`}
        >
          <p className="text-xs text-gray-500">Latest update</p>
          <p className="mt-0.5 text-base font-semibold text-gray-900">
            {view.currentStatus ?? 'Awaiting the first update'}
            {view.currentStatusLocation ? ` at ${view.currentStatusLocation}` : ''}
          </p>
          <p className="mt-2 text-sm text-gray-600">
            {view.isComplete ? 'Arrived ' : 'Expected '}
            <span className="font-medium text-gray-900">{fullDate(view.eta)}</span>
          </p>
        </section>

        <section className="mb-5 rounded-xl border border-gray-200 bg-white p-5">
          <h2 className="mb-4 text-sm font-semibold text-gray-900">Route</h2>
          <CargoTimeline stops={view.timeline} today={today} />
        </section>

        <section className="rounded-xl border border-gray-200 bg-white p-5">
          <dl className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-3">
            <div>
              <dt className="text-xs text-gray-500">From</dt>
              <dd className="mt-0.5 text-sm text-gray-900">{view.originCity ?? '—'}</dd>
            </div>
            <div>
              <dt className="text-xs text-gray-500">To</dt>
              <dd className="mt-0.5 text-sm text-gray-900">{view.destinationCity ?? '—'}</dd>
            </div>
            <div>
              <dt className="text-xs text-gray-500">Goods</dt>
              <dd className="mt-0.5 text-sm text-gray-900">{view.cargoDescription ?? '—'}</dd>
            </div>
            <div>
              <dt className="text-xs text-gray-500">Vessel</dt>
              <dd className="mt-0.5 text-sm text-gray-900">{view.vesselName ?? '—'}</dd>
            </div>
            <div>
              <dt className="text-xs text-gray-500">Carrier</dt>
              <dd className="mt-0.5 text-sm text-gray-900">{view.oceanCarrier ?? '—'}</dd>
            </div>
          </dl>
        </section>

        <p className="mt-6 text-center text-xs text-gray-400">
          Positions come from our freight forwarder and can change. Dates that have not happened yet are shown in grey.
        </p>
      </div>
    </main>
  )
}
