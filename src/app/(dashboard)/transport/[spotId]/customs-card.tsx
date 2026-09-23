import Link from 'next/link'
import { customsBillsForSpot } from '@/lib/customs/store.server'
import { estimateCustoms } from '@/lib/customs/estimate'
import { TONE_CLASSES, xeroChip } from '@/lib/customs/view'
import { formatDate, formatMoney } from '@/lib/utils'

/**
 * US duty on this container, for the person who handles customs bills.
 *
 * Dean, 23 Sep 2026: "the last part would be to have this duty tax as we already track shipments
 * via spot on the Hub". Once Nippon Express's invoice is in, the real figures; before that, an
 * estimate from the value booked with Cargo Partner and the rate for its origin on its date.
 */

export async function CustomsCard({
  spotId,
  destinationCountry,
  originCountry,
  goodsValue,
  currencyCode,
  eta,
  today,
}: {
  spotId: string
  destinationCountry: string | null
  originCountry: string | null
  goodsValue: number | null
  currencyCode: string | null
  eta: string | null
  today: string
}) {
  const bills = await customsBillsForSpot(spotId)
  if (bills.length === 0 && (destinationCountry ?? '').toUpperCase() !== 'US') return null

  return (
    <section className="mt-5 rounded-xl border border-gray-200 bg-white p-5">
      <h2 className="mb-1 text-base font-semibold text-gray-900" style={{ fontFamily: 'Varela Round, sans-serif' }}>
        US duty and fees
      </h2>

      {bills.length > 0 ? (
        <>
          <p className="mb-4 text-sm text-gray-500">From Nippon Express&apos;s invoice and CBP&apos;s entry summary.</p>
          <ul className="divide-y divide-gray-100">
            {bills.map((bill) => {
              const chip = xeroChip(bill)
              const service = bill.invoice_total != null && bill.customs_total != null ? bill.invoice_total - bill.customs_total : null
              return (
                <li key={bill.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                  <div>
                    <Link href={`/transport/customs/${bill.id}`} className="text-sm font-semibold text-[#025945] underline underline-offset-2">
                      {bill.invoice_number ?? 'Being read'}
                    </Link>
                    <p className="text-xs text-gray-500">
                      {formatDate(bill.invoice_date)}
                      {bill.entry_number ? ` · entry ${bill.entry_number}` : ''}
                    </p>
                  </div>
                  <dl className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
                    <div>
                      <dt className="text-xs text-gray-500">Duty and fees</dt>
                      <dd className="tabular-nums text-gray-900">{formatMoney(bill.customs_total)}</dd>
                    </div>
                    <div>
                      <dt className="text-xs text-gray-500">Nippon&apos;s charges</dt>
                      <dd className="tabular-nums text-gray-900">{formatMoney(service)}</dd>
                    </div>
                    <div>
                      <dt className="text-xs text-gray-500">Total</dt>
                      <dd className="font-semibold tabular-nums text-gray-900">{formatMoney(bill.invoice_total)}</dd>
                    </div>
                  </dl>
                  <span className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset ${TONE_CLASSES[chip.tone]}`}>
                    {chip.label}
                  </span>
                </li>
              )
            })}
          </ul>
        </>
      ) : (
        <Estimate
          goodsValue={goodsValue}
          currencyCode={currencyCode}
          originCountry={originCountry}
          onDate={eta && eta > today ? eta : today}
        />
      )}
    </section>
  )
}

function Estimate({
  goodsValue,
  currencyCode,
  originCountry,
  onDate,
}: {
  goodsValue: number | null
  currencyCode: string | null
  originCountry: string | null
  onDate: string
}) {
  const result = estimateCustoms({
    goodsValue: goodsValue == null ? null : Number(goodsValue),
    currency: currencyCode,
    originCountry,
    onDate,
  })
  if (!result.ok) {
    return <p className="text-sm text-gray-600">No estimate yet. {result.reason}</p>
  }
  const e = result.estimate
  // One string, so no line break in the source can drop a space from the sentence.
  const rate = `${Math.round(e.rule.rate * 1000) / 10}%`
  const entered = `$${e.enteredValue.toLocaleString('en-US')}`
  const lead =
    `An estimate until Nippon Express's invoice arrives: ${rate} duty on ${entered} (the ` +
    `${formatMoney(goodsValue)} booked with Cargo Partner, in whole dollars as CBP enters it), plus CBP's fees. ` +
    'If that value includes freight and insurance the estimate runs high; CBP charges duty on the goods and the palletising only.'
  return (
    <>
      <p className="mb-4 text-sm text-gray-500">{lead}</p>
      <dl className="flex flex-wrap gap-x-8 gap-y-2 text-sm">
        <div>
          <dt className="text-xs text-gray-500">Duty</dt>
          <dd className="tabular-nums text-gray-900">{formatMoney(e.duty)}</dd>
        </div>
        <div>
          <dt className="text-xs text-gray-500">Processing fee</dt>
          <dd className="tabular-nums text-gray-900">{formatMoney(e.mpf)}</dd>
        </div>
        <div>
          <dt className="text-xs text-gray-500">Harbor fee</dt>
          <dd className="tabular-nums text-gray-900">{formatMoney(e.hmf)}</dd>
        </div>
        <div>
          <dt className="text-xs text-gray-500">Estimated total</dt>
          <dd className="font-semibold tabular-nums text-gray-900">{formatMoney(e.total)}</dd>
        </div>
      </dl>
      <p className="mt-3 text-xs text-gray-500">{e.rule.basis}. Source: {e.rule.source}.</p>
    </>
  )
}
