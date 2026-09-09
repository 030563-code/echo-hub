'use client'

// page-state: none (the durable copy is the po_cargo_request row. Save writes
// the whole draft to that table, so nothing typed here is ever the only copy of
// itself for longer than one edit.)

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Ship, AlertTriangle } from 'lucide-react'
import {
  saveCargoRequest,
  approveAndSendCargoRequest,
} from '@/app/actions/purchase-orders/cargo-request'
import {
  INCOTERMS,
  MODALITIES,
  CATEGORIES,
  DIRECTIONS,
  PACKAGE_TYPES,
  PICKUP_PARTIES,
  SHIPPER,
  OFFICE_IN_CHARGE,
  type CargoDraft,
  type Modality,
  type Category,
  type Direction,
  type PackageType,
  type Incoterm,
} from '@/lib/cargo-request'

type Props = {
  poId: string
  canAct: boolean
  draft: CargoDraft
  sentAt: string | null
  sentTo: string[]
  sentWasTest: boolean
}

const stamp = (v: string | null) => (v ? new Date(v).toLocaleString('en-GB') : null)

/**
 * The approval step, by Dean's instruction on 9 Sep 2026: show the request that
 * is about to go out, with every field editable, and let a person release it.
 *
 * The wording says emailed, because emailed is what happens. The Cargo Partner
 * booking API is not switched on, and a screen that claims a booking nobody
 * made is worse than one that admits the leg is manual.
 */
export default function CargoRequestCard({ poId, canAct, draft, sentAt, sentTo, sentWasTest }: Props) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [form, setForm] = useState<CargoDraft>(draft)
  const sent = sentAt !== null

  const set = <K extends keyof CargoDraft>(key: K, value: CargoDraft[K]) =>
    setForm((f) => ({ ...f, [key]: value }))

  function save() {
    startTransition(async () => {
      const res = await saveCargoRequest({ po_id: poId, draft: form })
      if (!res.ok) toast.error(res.error)
      else toast.success(res.description)
      router.refresh()
    })
  }

  function send() {
    startTransition(async () => {
      const res = await approveAndSendCargoRequest({ po_id: poId, draft: form })
      if (!res.ok) toast.error(res.error)
      else toast.success(res.description)
      router.refresh()
    })
  }

  return (
    <div className="mt-6 rounded-xl border border-gray-200 bg-white p-5">
      <div className="flex items-start gap-3">
        <Ship className="w-5 h-5 text-gray-400 mt-0.5 shrink-0" />
        <div>
          <h2
            className="text-base font-semibold text-gray-900"
            style={{ fontFamily: 'Varela Round, sans-serif' }}
          >
            Shipment request
          </h2>
          <p className="text-sm text-gray-500 mt-0.5">
            {sent
              ? 'This request has gone to Cargo Partner.'
              : 'This is what is about to be emailed to Cargo Partner. Check every field. Nothing leaves until you press Approve and send.'}
          </p>
        </div>
      </div>

      {sent ? (
        <div className="mt-4 rounded-lg border border-gray-200 bg-gray-50 p-4 text-sm">
          <p className={sentWasTest ? 'text-amber-700' : 'text-gray-900'}>
            {sentWasTest
              ? `Sent ${stamp(sentAt)} to the test address (${sentTo.join(', ')}), not Cargo Partner.`
              : `Sent ${stamp(sentAt)} to ${sentTo.join(', ')}.`}
          </p>
          <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1.5 text-sm sm:grid-cols-3">
            <Fact label="Reference" value={form.general_reference} />
            <Fact label="Cargo ready" value={form.cargo_readiness_date} />
            <Fact label="Incoterm" value={form.delivery_term ?? 'not given'} />
            <Fact label="Pieces" value={`${form.pieces} x ${form.package_type_code}`} />
            <Fact
              label="Route"
              value={`${form.main_modality} / ${form.main_category} / ${form.business_direction}`}
            />
            <Fact label="Deliver to" value={form.consignee_name || 'not named'} />
          </dl>
        </div>
      ) : (
        <>
          <div className="mt-5 grid gap-4 sm:grid-cols-2">
            {/*
              Fixed, by Dean's instruction on 9 Sep 2026. This is the key Cargo
              Partner index the shipment under and the key the SPOT lookup
              searches on, so a typo here loses the shipment rather than
              renaming it. The server pins it to the purchase order number on
              every save and send, so this is a matching display, not the guard.
            */}
            <Field label="General reference" hint="The purchase order number. Fixed.">
              <p className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm font-mono text-gray-900">
                {form.general_reference || '—'}
              </p>
            </Field>

            <Field
              label="Cargo ready"
              hint={
                form.pickup_from === 'EB_SRO'
                  ? 'When it can be collected from Kosice'
                  : 'When it can be collected from Presov'
              }
            >
              <input
                type="date"
                className={INPUT}
                value={form.cargo_readiness_date}
                onChange={(e) => set('cargo_readiness_date', e.target.value)}
                disabled={!canAct}
              />
            </Field>

            <Field
              label="Incoterm"
              hint="Who pays for this leg. Nobody has told us yet, so it goes out blank unless you set it."
            >
              <select
                className={INPUT}
                value={form.delivery_term ?? ''}
                onChange={(e) => set('delivery_term', e.target.value ? (e.target.value as Incoterm) : null)}
                disabled={!canAct}
              >
                <option value="">Not confirmed, ask them</option>
                {INCOTERMS.map((term) => (
                  <option key={term} value={term}>
                    {term}
                  </option>
                ))}
              </select>
            </Field>

            <Field label="Package type">
              <select
                className={INPUT}
                value={form.package_type_code}
                onChange={(e) => set('package_type_code', e.target.value as PackageType)}
                disabled={!canAct}
              >
                {PACKAGE_TYPES.map((code) => (
                  <option key={code} value={code}>
                    {code}
                  </option>
                ))}
              </select>
            </Field>

            <Field label="Pieces" hint={`Pallets, at ${form.lines.reduce((n, l) => n + l.pallets, 0)} from the order lines`}>
              <input
                type="number"
                min={0}
                className={INPUT}
                value={form.pieces}
                onChange={(e) => set('pieces', Number(e.target.value))}
                disabled={!canAct}
              />
            </Field>

            <Field label="Modality">
              <select
                className={INPUT}
                value={form.main_modality}
                onChange={(e) => set('main_modality', e.target.value as Modality)}
                disabled={!canAct}
              >
                {MODALITIES.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </Field>

            <Field label="Category">
              <select
                className={INPUT}
                value={form.main_category}
                onChange={(e) => set('main_category', e.target.value as Category)}
                disabled={!canAct}
              >
                {CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </Field>

            <Field label="Direction">
              <select
                className={INPUT}
                value={form.business_direction}
                onChange={(e) => set('business_direction', e.target.value as Direction)}
                disabled={!canAct}
              >
                {DIRECTIONS.map((d) => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))}
              </select>
            </Field>

            <Field label="Cargo description" className="sm:col-span-2">
              <input
                className={INPUT}
                value={form.description}
                onChange={(e) => set('description', e.target.value)}
                disabled={!canAct}
              />
            </Field>

            <Field label="Deliver to" hint="The depot that started this chain">
              <input
                className={INPUT}
                value={form.consignee_name}
                onChange={(e) => set('consignee_name', e.target.value)}
                placeholder="Depot not recorded in the Hub"
                disabled={!canAct}
              />
            </Field>

            <Field label="Delivery address">
              <input
                className={INPUT}
                value={form.consignee_address}
                onChange={(e) => set('consignee_address', e.target.value)}
                placeholder="Not recorded in the Hub"
                disabled={!canAct}
              />
            </Field>

            <Field label="Send to" hint="Cargo Partner's booking inbox" className="sm:col-span-2">
              <input
                className={INPUT}
                value={form.to}
                onChange={(e) => set('to', e.target.value)}
                placeholder="nobody yet, add an address"
                disabled={!canAct}
              />
            </Field>

            <Field label="Copy to" className="sm:col-span-2">
              <input
                className={INPUT}
                value={form.cc}
                onChange={(e) => set('cc', e.target.value)}
                disabled={!canAct}
              />
            </Field>

            <Field label="Anything else they should know" className="sm:col-span-2">
              <textarea
                rows={3}
                className={INPUT}
                value={form.notes}
                onChange={(e) => set('notes', e.target.value)}
                placeholder="Optional. Goes into the email as written."
                disabled={!canAct}
              />
            </Field>
          </div>

          <div className="mt-5 rounded-lg border border-gray-200 bg-gray-50 p-4 text-sm">
            <p className="text-xs uppercase tracking-wider text-gray-500 mb-2">Fixed on every request</p>
            <dl className="grid grid-cols-1 gap-y-1.5 sm:grid-cols-3 sm:gap-x-6">
              {/* Bamida for a made order, our own Kosice shelf for stock. */}
              <Fact
                label="Collect from"
                value={`${PICKUP_PARTIES[form.pickup_from].name}, account ${PICKUP_PARTIES[form.pickup_from].account}`}
              />
              <Fact label="Shipper" value={`${SHIPPER.name}, account ${SHIPPER.account}`} />
              <Fact
                label="Office in charge"
                value={`${OFFICE_IN_CHARGE.name}, account ${OFFICE_IN_CHARGE.account}`}
              />
            </dl>
          </div>

          {!form.delivery_term && (
            <p className="mt-4 flex items-start gap-2 text-sm text-amber-700">
              <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
              No Incoterm. The email will ask Cargo Partner for one rather than assume a term that
              decides who pays for the freight.
            </p>
          )}

          {canAct ? (
            <div className="mt-5 flex flex-wrap items-center gap-2">
              <button
                onClick={send}
                disabled={pending}
                className="px-5 py-2 bg-echo-orange hover:bg-echo-orange-hover text-white text-sm font-medium rounded-lg disabled:opacity-50 transition-colors"
              >
                {pending ? 'Working...' : 'Approve and send'}
              </button>
              <button
                onClick={save}
                disabled={pending}
                className="px-4 py-2 text-sm rounded-lg border border-gray-300 text-gray-700 hover:text-gray-900 hover:bg-gray-100 disabled:opacity-50 transition-colors"
              >
                Save without sending
              </button>
              <span className="text-xs text-gray-400">
                Emailed only. Nothing is written to the Cargo Partner API.
              </span>
            </div>
          ) : (
            <p className="mt-5 text-xs text-gray-400">
              Read only. You need po.create to release this request.
            </p>
          )}
        </>
      )}
    </div>
  )
}

const INPUT =
  'w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 focus:border-echo-orange focus:outline-none focus:ring-1 focus:ring-echo-orange disabled:bg-gray-50 disabled:text-gray-500'

function Field({
  label,
  hint,
  className,
  children,
}: {
  label: string
  hint?: string
  className?: string
  children: React.ReactNode
}) {
  return (
    <label className={`block ${className ?? ''}`}>
      <span className="block text-xs font-medium uppercase tracking-wider text-gray-500 mb-1.5">
        {label}
      </span>
      {children}
      {hint && <span className="mt-1 block text-xs text-gray-400">{hint}</span>}
    </label>
  )
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-gray-500">{label}</dt>
      <dd className="text-gray-900">{value}</dd>
    </div>
  )
}
