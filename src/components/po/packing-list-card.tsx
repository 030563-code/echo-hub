'use client'

// page-state: none (the despatch details are typed for one download; the document is the record and nothing here outlives the click)

import { useState } from 'react'
import { toast } from 'sonner'
import { FileDown, Loader2, Package } from 'lucide-react'
import { downloadPackingList } from '@/app/actions/purchase-orders/download-packing-list'
import { saveFactoryPdf } from '@/lib/factory/save-pdf'
import { palletRef } from '@/lib/despatch/pack-weights'
import type { PackingListParty } from '@/lib/despatch/packing-list'
import type { PackingListPreview } from '@/lib/despatch/packing-list-source'

export interface PackingListCardData {
  poNumber: string
  groupPoNumber: string | null
  destination: string | null
  defaults: { date: string; consignee: PackingListParty; placeOfCollection: string[] }
  /** What prints with the defaults: the pallets and weights do not depend on anything typed below. */
  preview: PackingListPreview
  spec: { saved: boolean; confirmedAt: string | null }
}

const field =
  'w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-echo-orange/40'
const primary =
  'inline-flex items-center justify-center gap-2 rounded-lg bg-[#025945] px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-[#03674f] disabled:opacity-60'
const secondary =
  'inline-flex items-center justify-center gap-2 rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 disabled:opacity-60'

const kg = (v: number) => `${new Intl.NumberFormat('en-GB', { maximumFractionDigits: 1 }).format(v)} kg`

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
      <span className="mb-1.5 block text-xs font-medium uppercase tracking-wider text-gray-500">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-gray-400">{hint}</span>}
    </label>
  )
}

/**
 * The despatch pack's first document, from the order page.
 *
 * Two copies leave Prešov with every container and both are typed by hand
 * today: PL-A on s.r.o. letterhead and PL-B on Group letterhead, the same
 * pallets and weights on each. Here they are built from the signed
 * manufacturing specification, and the person despatching types only what the
 * specification cannot know: the despatch date, the consignee, the factory's
 * pallet counter, the incoterms and a contact.
 *
 * Nothing typed here is stored. The document is the record, the same inputs
 * render the same bytes, and the warnings say what the Hub could not resolve
 * (a weight it does not hold, an HS code nobody has entered, a pallet count
 * that disagrees with the signature) so that gets fixed at the source.
 */
export default function PackingListCard({ poId, data }: { poId: string; data: PackingListCardData }) {
  const [date, setDate] = useState(data.defaults.date)
  const [consigneeName, setConsigneeName] = useState(data.defaults.consignee.name)
  const [consigneeAddress, setConsigneeAddress] = useState(data.defaults.consignee.address.join('\n'))
  const [sameDeliverTo, setSameDeliverTo] = useState(true)
  const [deliverToName, setDeliverToName] = useState(data.defaults.consignee.name)
  const [deliverToAddress, setDeliverToAddress] = useState(data.defaults.consignee.address.join('\n'))
  const [attnName, setAttnName] = useState('')
  const [attnPhone, setAttnPhone] = useState('')
  const [attnEmail, setAttnEmail] = useState('')
  const [incoterms, setIncoterms] = useState('DAP')
  const [firstPallet, setFirstPallet] = useState(1)
  const [comments, setComments] = useState('')
  const [busy, setBusy] = useState<null | 'A' | 'B'>(null)
  const [warnings, setWarnings] = useState<string[]>(data.preview.warnings)

  const lines = (text: string) =>
    text
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
  const consignee = { name: consigneeName, address: lines(consigneeAddress) }
  const firstRef = date.length === 10 && firstPallet >= 1 ? palletRef(date.slice(0, 7), firstPallet) : ''
  const { preview } = data
  const disagreement = preview.signedPallets !== null && preview.signedPallets !== preview.pallets

  async function download(variant: 'A' | 'B') {
    setBusy(variant)
    try {
      const res = await downloadPackingList({
        poId,
        variant,
        date,
        consignee,
        deliverTo: sameDeliverTo ? consignee : { name: deliverToName, address: lines(deliverToAddress) },
        attention: { name: attnName || null, phone: attnPhone || null, email: attnEmail || null },
        incoterms: incoterms.trim() || null,
        firstPalletNumber: firstPallet,
        comments: comments.trim() || null,
      })
      if (!res.ok) throw new Error(res.error)
      saveFactoryPdf(res)
      setWarnings(res.warnings)
      toast.success(`Packing list ${variant} downloaded`)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not build the packing list')
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="rounded-xl border border-gray-200 bg-white p-5">
      <div className="flex items-start gap-3">
        <Package className="mt-0.5 h-5 w-5 shrink-0 text-gray-400" />
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-semibold text-gray-900" style={{ fontFamily: 'Varela Round, sans-serif' }}>
            Packing list
          </h2>
          <p className="mt-0.5 text-sm text-gray-500">
            Two copies leave Prešov with the container: A on s.r.o. letterhead, B on Group letterhead. Same
            pallets, same weights, built from the{' '}
            {data.spec.confirmedAt ? 'confirmed' : data.spec.saved ? 'saved but unconfirmed' : 'generated, unsaved'}{' '}
            specification
            {data.groupPoNumber ? (
              <>
                {' '}
                under order <span className="font-mono">{data.groupPoNumber}</span>
              </>
            ) : null}
            .
          </p>
        </div>
      </div>

      <div className="mt-4 rounded-lg border border-gray-200 bg-gray-50 p-4 text-sm">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs font-medium uppercase tracking-wider text-gray-500">
              <th className="pb-2 font-medium">Goods</th>
              <th className="pb-2 text-right font-medium">Qty</th>
              <th className="pb-2 pl-4 font-medium">HS code</th>
              <th className="pb-2 text-right font-medium">Per pc</th>
            </tr>
          </thead>
          <tbody>
            {preview.lines.map((l) => (
              <tr key={l.description} className="border-t border-gray-200">
                <td className="py-1.5 pr-3 text-gray-900">{l.description}</td>
                <td className="py-1.5 text-right tabular-nums text-gray-900">{l.quantity}</td>
                <td className="py-1.5 pl-4 font-mono text-gray-700">
                  {l.hsCode ?? <span className="font-sans text-amber-700">missing</span>}
                </td>
                <td className="py-1.5 text-right tabular-nums text-gray-700">
                  {l.unitNetKg === null ? <span className="text-amber-700">no weight</span> : kg(l.unitNetKg)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mt-3 border-t border-gray-200 pt-3 text-gray-700">
          <span className="font-medium text-gray-900">
            {preview.signedPallets ?? preview.pallets} {(preview.signedPallets ?? preview.pallets) === 1 ? 'pallet' : 'pallets'}
          </span>
          {disagreement ? (
            <span className="text-amber-700"> (signed; the products make {preview.pallets})</span>
          ) : null}
          {' · '}
          {kg(preview.totalNetKg)} net / {kg(preview.totalGrossKg)} gross
          {' · '}collected at {data.defaults.placeOfCollection.join(', ')}
        </p>
        {!preview.weightsConfirmed && (
          <p className="mt-1.5 text-xs text-amber-700">
            Weights are read off Bamida&apos;s past packing lists and not yet confirmed by Juraj. The document says
            so on its face.
          </p>
        )}
      </div>

      {warnings.length > 0 && (
        <ul className="mt-3 space-y-1 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">
          {warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      )}

      <div className="mt-5 grid gap-4 sm:grid-cols-2">
        <Field label="Despatch date" hint={firstRef ? `Pallets are numbered by month: the first prints as ${firstRef}` : undefined}>
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className={field} />
        </Field>
        <Field
          label="First pallet number"
          hint="The factory's counter for the month. This container's first pallet takes the next free number."
        >
          <input
            type="number"
            min={1}
            max={999}
            value={firstPallet}
            onChange={(e) => setFirstPallet(Math.max(1, Math.round(Number(e.target.value) || 1)))}
            className={field}
          />
        </Field>
        <Field label="Consignee" hint="Who the goods are consigned to. One address line per row." className="sm:col-span-2">
          <input value={consigneeName} onChange={(e) => setConsigneeName(e.target.value)} className={`${field} mb-2`} placeholder="Company" />
          <textarea value={consigneeAddress} onChange={(e) => setConsigneeAddress(e.target.value)} rows={4} className={field} />
        </Field>
        <label className="flex items-center gap-2 text-sm text-gray-700 sm:col-span-2">
          <input type="checkbox" checked={sameDeliverTo} onChange={(e) => setSameDeliverTo(e.target.checked)} className="h-4 w-4 rounded border-gray-300" />
          Deliver to the consignee&apos;s address
        </label>
        {!sameDeliverTo && (
          <Field label="Deliver to" className="sm:col-span-2">
            <input value={deliverToName} onChange={(e) => setDeliverToName(e.target.value)} className={`${field} mb-2`} placeholder="Company" />
            <textarea value={deliverToAddress} onChange={(e) => setDeliverToAddress(e.target.value)} rows={4} className={field} />
          </Field>
        )}
        <Field label="Attention">
          <input value={attnName} onChange={(e) => setAttnName(e.target.value)} className={field} placeholder="Name" />
        </Field>
        <Field label="Incoterms" hint="As it should print, e.g. DAP Jessup">
          <input value={incoterms} onChange={(e) => setIncoterms(e.target.value)} className={field} />
        </Field>
        <Field label="Phone">
          <input value={attnPhone} onChange={(e) => setAttnPhone(e.target.value)} className={field} />
        </Field>
        <Field label="Email">
          <input type="email" value={attnEmail} onChange={(e) => setAttnEmail(e.target.value)} className={field} />
        </Field>
        <Field label="Comments" className="sm:col-span-2">
          <textarea value={comments} onChange={(e) => setComments(e.target.value)} rows={2} className={field} />
        </Field>
      </div>

      <div className="mt-5 flex flex-wrap gap-2">
        <button type="button" onClick={() => download('A')} disabled={busy !== null} className={primary}>
          {busy === 'A' ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileDown className="h-4 w-4" />}
          Packing list A (s.r.o.)
        </button>
        <button type="button" onClick={() => download('B')} disabled={busy !== null} className={secondary}>
          {busy === 'B' ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileDown className="h-4 w-4" />}
          Packing list B (Group)
        </button>
      </div>
    </div>
  )
}
