import { depotLabel } from '@/lib/depot-constants'
import {
  formatTaxRate,
  summariseTaxResponse,
  type DepotTaxBreakdown,
} from '@/lib/customer-invoice/tax-breakdown'

/**
 * What TaxJar actually returned, shown after Save draft.
 *
 * The totals block above says how much tax. This says WHY, and it is the only
 * place a reviewer can catch the failure that matters: a delivery address that
 * resolves to the wrong jurisdiction does not error, it returns a different
 * rate. Seeing "Los Angeles, Los Angeles County, CA" next to 9.750% is the
 * check. A total on its own is not.
 *
 * The same summary prints on the customer's invoice, so what is reviewed here
 * is exactly what the customer will receive.
 */
export function TaxDetail({
  taxjarResponse,
  currency,
}: {
  taxjarResponse: unknown
  currency: string
}) {
  const groups = summariseTaxResponse(taxjarResponse)
  if (groups.length === 0) return null

  const money = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })

  return (
    <div className="mt-4 rounded-lg border border-gray-200 bg-gray-50 p-4">
      <h3 className="text-[11px] font-bold uppercase tracking-wider text-gray-500">Tax detail from TaxJar</h3>
      <div className="mt-3 space-y-4">
        {groups.map((group) => (
          <DepotGroup key={group.depot} group={group} money={money} multiple={groups.length > 1} />
        ))}
      </div>
    </div>
  )
}

function DepotGroup({
  group,
  money,
  multiple,
}: {
  group: DepotTaxBreakdown
  money: Intl.NumberFormat
  multiple: boolean
}) {
  return (
    <div>
      <div className="flex flex-wrap items-baseline gap-x-2 text-sm">
        {multiple && <span className="font-semibold text-gray-900">{depotLabel(group.depot)}</span>}
        {multiple && <span className="text-gray-300">/</span>}
        <span className="text-gray-900">{group.resolvedPlace || 'jurisdiction not reported'}</span>
        {group.combinedRate !== null && (
          <span className="text-gray-500">{formatTaxRate(group.combinedRate)} combined</span>
        )}
      </div>

      <dl className="mt-2 space-y-1 text-sm text-gray-700">
        {group.jurisdictions.map((j) => (
          <div key={j.label} className="flex justify-between gap-8 sm:max-w-sm">
            <dt>
              {j.label} <span className="text-gray-400 tabular-nums">{formatTaxRate(j.rate)}</span>
            </dt>
            <dd className="tabular-nums">{money.format(j.amount)}</dd>
          </div>
        ))}
        <div className="flex justify-between gap-8 border-t border-gray-200 pt-1 font-semibold text-gray-900 sm:max-w-sm">
          <dt>Sales tax</dt>
          <dd className="tabular-nums">{money.format(group.salesTax)}</dd>
        </div>
      </dl>

      {/* Freight treatment is TaxJar's call per destination, never the Hub's:
          California exempts separately stated freight and New Jersey taxes it.
          Saying which one happened here is what stops someone "fixing" it. */}
      <p className="mt-2 text-xs text-gray-500">
        {group.freightTaxable
          ? `Freight is taxable in this jurisdiction: ${money.format(group.shippingTax)} of the tax above is on freight.`
          : 'Separately stated freight is exempt in this jurisdiction.'}
      </p>
    </div>
  )
}

/**
 * What Xero actually returned on the draft, for an organisation whose tax is
 * priced by Xero rather than TaxJar.
 *
 * Same job as TaxDetail: the totals block says how much, this says WHY, and it
 * is where a reviewer catches the failure that matters. For France that
 * failure is a draft that came back zero-rated because the tax type did not
 * take. calculate-tax-fr.ts refuses such a draft outright, so a card that
 * renders at all is one whose lines all carried tax; the card makes the rate
 * visible anyway, because a rate the reviewer has seen is a rate somebody can
 * question.
 */
export function XeroDraftTaxDetail({
  response,
  currency,
  locale,
  taxLabel,
}: {
  response: unknown
  currency: string
  locale?: string
  taxLabel: string
}) {
  const stored = response as {
    engine?: string
    response?: {
      xero_draft_invoice_id?: string
      xero_invoice_number?: string | null
      total_tax?: number
      lines?: { line_key: string; line_amount: number; tax_type: string | null; tax_amount: number }[]
    }
  } | null
  if (!stored || stored.engine !== 'xero_draft' || !stored.response) return null
  const draft = stored.response
  const lines = Array.isArray(draft.lines) ? draft.lines : []
  if (lines.length === 0) return null

  const money = new Intl.NumberFormat(locale ?? 'en-US', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
  const taxTypes = [...new Set(lines.map((l) => l.tax_type).filter((t): t is string => Boolean(t)))]
  const priced = lines.filter((l) => Number(l.line_amount) > 0)
  const rate =
    priced.length > 0
      ? priced.reduce((acc, l) => acc + Number(l.tax_amount), 0) / priced.reduce((acc, l) => acc + Number(l.line_amount), 0)
      : null

  return (
    <div className="mt-4 rounded-lg border border-gray-200 bg-gray-50 p-4">
      <h3 className="text-[11px] font-bold uppercase tracking-wider text-gray-500">{taxLabel} priced by Xero</h3>
      <div className="mt-2 flex flex-wrap items-baseline gap-x-2 text-sm">
        <span className="text-gray-900">
          Draft {draft.xero_invoice_number ?? draft.xero_draft_invoice_id ?? ''} in Xero
        </span>
        {rate !== null && <span className="text-gray-500">{formatTaxRate(rate)} across the priced lines</span>}
      </div>
      <dl className="mt-2 space-y-1 text-sm text-gray-700">
        <div className="flex justify-between gap-8 sm:max-w-sm">
          <dt>
            Tax type <span className="text-gray-400">{taxTypes.join(', ') || 'not reported'}</span>
          </dt>
          <dd className="tabular-nums">{money.format(Number(draft.total_tax ?? 0))}</dd>
        </div>
      </dl>
      <p className="mt-2 text-xs text-gray-500">
        Xero computed this from the tax type on each line. The authorised invoice will carry the same figures;
        nothing is filed anywhere else.
      </p>
    </div>
  )
}
