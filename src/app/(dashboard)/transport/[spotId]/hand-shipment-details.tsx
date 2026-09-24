'use client'
// page-state: none (the durable copy is the transport_shipment row. Save writes every field at
// once, and the SPOT ID box is typed and sent in one go.)

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Link2, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { deleteHandShipment, linkShipmentToSpot, updateHandShipment } from '@/app/actions/transport/shipments'
import { depotLabel } from '@/lib/depot-constants'
import type { HubShipment } from '@/lib/transport/shipment'

/**
 * Everything Dave's tab holds about a container that is not booked with Cargo Partner yet: where
 * it is going, the containers, the shipper and each date on the way. Once Cargo Partner has booked
 * it, the SPOT ID joins it to the tracking and the dates come from the forwarder instead.
 */

interface Form {
  depot: string
  containers: string
  shipper: string
  bookedOn: string
  collectedOn: string
  shippedOn: string
  etaPort: string
  etaDepot: string
  deliveredOn: string
  notes: string
}

const DATES: { key: keyof Form; label: string }[] = [
  { key: 'bookedOn', label: 'Order date' },
  { key: 'collectedOn', label: 'Collected' },
  { key: 'shippedOn', label: 'Shipped' },
  { key: 'etaPort', label: 'Due at the port' },
  { key: 'etaDepot', label: 'Due at the depot' },
  { key: 'deliveredOn', label: 'Delivered' },
]

const input =
  'mt-1 w-full rounded-lg border border-gray-300 bg-white px-2.5 py-1.5 text-sm focus:border-[#025945] focus:outline-none'

export default function HandShipmentDetails({ shipment, depots }: { shipment: HubShipment; depots: string[] }) {
  const [form, setForm] = useState<Form>({
    depot: shipment.depot ?? depots[0] ?? '',
    containers: shipment.containers.join(', '),
    shipper: shipment.shipper ?? '',
    bookedOn: shipment.bookedOn ?? '',
    collectedOn: shipment.collectedOn ?? '',
    shippedOn: shipment.shippedOn ?? '',
    etaPort: shipment.etaPort ?? '',
    etaDepot: shipment.etaDepot ?? '',
    deliveredOn: shipment.deliveredOn ?? '',
    notes: shipment.notes ?? '',
  })
  const [spot, setSpot] = useState('')
  const [pending, startTransition] = useTransition()
  const router = useRouter()
  const set = (key: keyof Form, value: string) => setForm((f) => ({ ...f, [key]: value }))
  // The depot it is going to stays on the list even if the caller could not choose it now.
  const depotChoices = shipment.depot && !depots.includes(shipment.depot) ? [shipment.depot, ...depots] : depots

  function save() {
    startTransition(async () => {
      try {
        const res = await updateHandShipment({
          id: shipment.id,
          details: {
            depot: form.depot,
            containers: form.containers,
            shipper: form.shipper || null,
            bookedOn: form.bookedOn || null,
            collectedOn: form.collectedOn || null,
            shippedOn: form.shippedOn || null,
            etaPort: form.etaPort || null,
            etaDepot: form.etaDepot || null,
            deliveredOn: form.deliveredOn || null,
            notes: form.notes || null,
          },
        })
        if (!res.success) {
          toast.error(res.error)
          return
        }
        toast.success(res.message)
        router.refresh()
      } catch {
        toast.error('That did not go through. Please try again.')
      }
    })
  }

  function link(e: React.FormEvent) {
    e.preventDefault()
    if (!spot.trim() || pending) return
    startTransition(async () => {
      try {
        const res = await linkShipmentToSpot({ id: shipment.id, value: spot })
        if (!res.success) {
          toast.error(res.error)
          return
        }
        toast.success(res.message)
        router.push(`/transport/${res.spotId}`)
      } catch {
        toast.error('That did not go through. Please try again.')
      }
    })
  }

  function remove() {
    if (!window.confirm('Delete this shipment and everything typed on it? This cannot be undone.')) return
    startTransition(async () => {
      try {
        const res = await deleteHandShipment({ id: shipment.id })
        if (!res.success) {
          toast.error(res.error)
          return
        }
        toast.success(res.message)
        router.push('/transport')
      } catch {
        toast.error('That did not go through. Please try again.')
      }
    })
  }

  return (
    <section className="rounded-xl border border-gray-200 bg-white p-5">
      <h2 className="mb-4 text-base font-semibold text-gray-900" style={{ fontFamily: 'Varela Round, sans-serif' }}>
        Shipment
      </h2>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <label className="block">
          <span className="text-xs text-gray-500">Going to</span>
          <select value={form.depot} onChange={(e) => set('depot', e.target.value)} className={input}>
            {depotChoices.map((d) => (
              <option key={d} value={d}>
                {depotLabel(d)}
              </option>
            ))}
          </select>
        </label>
        <label className="block sm:col-span-2">
          <span className="text-xs text-gray-500">Container numbers</span>
          <input
            value={form.containers}
            onChange={(e) => set('containers', e.target.value)}
            placeholder="ABCU1234567, separated by commas"
            maxLength={200}
            className={`${input} uppercase`}
          />
        </label>
        <label className="block">
          <span className="text-xs text-gray-500">Shipper</span>
          <input
            value={form.shipper}
            onChange={(e) => set('shipper', e.target.value)}
            placeholder="Cargo Partner"
            maxLength={80}
            className={input}
          />
        </label>
        {DATES.map(({ key, label }) => (
          <label key={key} className="block">
            <span className="text-xs text-gray-500">{label}</span>
            <input type="date" value={form[key]} onChange={(e) => set(key, e.target.value)} className={`${input} tabular-nums`} />
          </label>
        ))}
        <label className="block sm:col-span-2 lg:col-span-3">
          <span className="text-xs text-gray-500">Notes</span>
          <textarea
            value={form.notes}
            onChange={(e) => set('notes', e.target.value)}
            rows={2}
            maxLength={2000}
            className={input}
          />
        </label>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={remove}
          disabled={pending}
          className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-sm text-gray-500 transition-colors hover:bg-red-50 hover:text-red-700"
        >
          <Trash2 className="h-4 w-4" /> Delete
        </button>
        <span className="flex-1" />
        <button
          type="button"
          onClick={save}
          disabled={pending}
          className="rounded-lg bg-[#025945] px-4 py-1.5 text-sm font-medium text-white transition-colors hover:bg-[#03674f] disabled:opacity-60"
        >
          {pending ? 'Saving' : 'Save'}
        </button>
      </div>

      <form onSubmit={link} className="mt-5 border-t border-gray-100 pt-4">
        <p className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-gray-400">
          <Link2 className="h-3.5 w-3.5" /> Booked with Cargo Partner?
        </p>
        <p className="mb-2 text-sm text-gray-600">
          Type its SPOT ID and the Hub checks it with Cargo Partner, then tracks it. What is typed here stays on it.
        </p>
        <div className="flex flex-wrap gap-2">
          <input
            value={spot}
            onChange={(e) => setSpot(e.target.value)}
            maxLength={80}
            aria-label="SPOT ID or order reference"
            placeholder="SPOT ID or order reference"
            className="min-w-56 flex-1 rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm placeholder:text-gray-400 focus:border-[#025945] focus:outline-none"
          />
          <button
            type="submit"
            disabled={pending || !spot.trim()}
            className="rounded-lg border border-[#025945] px-3 py-1.5 text-sm font-medium text-[#025945] transition-colors hover:bg-[#025945]/5 disabled:opacity-60"
          >
            {pending ? 'Checking with Cargo Partner' : 'Link'}
          </button>
        </div>
      </form>
    </section>
  )
}
