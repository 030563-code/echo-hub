/**
 * What TaxJar actually said, made printable.
 *
 * `customer_invoices.taxjar_response` stores the WHOLE response per ship-from
 * depot, but the app only ever read three fields back out of it. Everything
 * needed to show a customer why they are being charged what they are being
 * charged is already in there: the jurisdiction TaxJar resolved the address to,
 * and the split of the combined rate into state, county, city and special
 * district.
 *
 * Two callers, one shape. The invoice editor shows this after Save draft so a
 * reviewer can check the resolved place before anything is filed, and the
 * printed invoice shows it under the total so the customer can reconcile it.
 * Deriving it twice would let the screen and the document disagree.
 *
 * Pure and defensive: the column is `unknown`, the response is a third party's,
 * and a missing field must degrade to "not shown" rather than throw inside a
 * PDF render or a page load.
 */

/** One row of the rate split, e.g. State 6.250% = 3,147.50. */
export interface TaxJurisdictionAmount {
  label: string
  rate: number
  amount: number
}

export interface DepotTaxBreakdown {
  depot: string
  /** Where TaxJar decided the sale happened, title-cased for display. TaxJar
   *  returns these upper-cased. This is the check that matters: a bad zip
   *  returns a different jurisdiction rather than an error. */
  resolvedPlace: string
  combinedRate: number | null
  taxableAmount: number
  /** Tax on the freight component. Zero where the state exempts separately
   *  stated freight (California) and non-zero where it does not (New Jersey).
   *  TaxJar decides this per call; the Hub must never assume either way. */
  shippingTax: number
  freightTaxable: boolean
  jurisdictions: TaxJurisdictionAmount[]
  salesTax: number
}

function num(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : 0
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

/** TaxJar returns city and county upper-cased ("LOS ANGELES COUNTY"), which
 *  reads as shouting on a customer document. */
function titleCase(value: unknown): string {
  const s = String(value ?? '').trim()
  if (s === '') return ''
  return s
    .toLowerCase()
    .split(/\s+/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
}

function roundCents(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100
}

/**
 * The four levels TaxJar splits a combined rate into.
 *
 * Each carries its own rate key and amount key, and a level that does not apply
 * comes back as a zero rather than being absent, which is why a zero-amount
 * level is dropped rather than printed as "City 0.000% = 0.00".
 */
const LEVELS: { label: string; rateKey: string; amountKey: string }[] = [
  { label: 'State', rateKey: 'state_sales_tax_rate', amountKey: 'state_amount' },
  { label: 'County', rateKey: 'county_tax_rate', amountKey: 'county_amount' },
  { label: 'City', rateKey: 'city_tax_rate', amountKey: 'city_amount' },
  { label: 'Special district', rateKey: 'special_tax_rate', amountKey: 'special_district_amount' },
]

/**
 * Summarise one stored TaxJar response.
 *
 * Amounts are summed across every breakdown line AND the shipping breakdown,
 * so the jurisdiction rows add up to the sales tax actually charged. Rates are
 * taken from the first line that carries one: a single destination has one rate
 * per level by definition, so summing rates would be meaningless.
 */
export function summariseDepotResponse(depot: string, response: unknown): DepotTaxBreakdown {
  const tax = record(record(response)?.tax)
  const jurisdictions = record(tax?.jurisdictions)
  const breakdown = record(tax?.breakdown)
  const lineItems = Array.isArray(breakdown?.line_items) ? (breakdown.line_items as unknown[]) : []
  const shipping = record(breakdown?.shipping)

  const place = [titleCase(jurisdictions?.city), titleCase(jurisdictions?.county), String(jurisdictions?.state ?? '').trim()]
    .filter((part) => part !== '')
    .join(', ')

  // The shipping breakdown participates in every sum: where freight is taxable
  // its tax belongs in the jurisdiction rows like any other line.
  const contributors = [...lineItems, ...(shipping ? [shipping] : [])]
    .map(record)
    .filter((r): r is Record<string, unknown> => r !== null)

  const jurisdictionRows: TaxJurisdictionAmount[] = []
  for (const level of LEVELS) {
    const amount = roundCents(contributors.reduce((acc, c) => acc + num(c[level.amountKey]), 0))
    if (amount === 0) continue
    const withRate = contributors.find((c) => num(c[level.rateKey]) > 0)
    jurisdictionRows.push({ label: level.label, rate: num(withRate?.[level.rateKey]), amount })
  }

  const shippingTax = roundCents(num(shipping?.tax_collectable))

  return {
    depot,
    resolvedPlace: place,
    combinedRate: tax?.rate === undefined || tax?.rate === null ? null : num(tax.rate),
    taxableAmount: roundCents(num(tax?.taxable_amount)),
    shippingTax,
    freightTaxable: tax?.freight_taxable === true,
    jurisdictions: jurisdictionRows,
    salesTax: roundCents(contributors.reduce((acc, c) => acc + num(c.tax_collectable), 0)),
  }
}

/**
 * Summarise the whole stored column, which is an array of
 * `{ depot, request, response }` written one entry per ship-from depot.
 *
 * Returns an empty array rather than throwing when tax has not been calculated
 * yet, or when the column holds something unexpected.
 */
export function summariseTaxResponse(taxjarResponse: unknown): DepotTaxBreakdown[] {
  if (!Array.isArray(taxjarResponse)) return []
  return taxjarResponse
    .map(record)
    .filter((entry): entry is Record<string, unknown> => entry !== null)
    .map((entry) => summariseDepotResponse(String(entry.depot ?? ''), entry.response))
}

/** Percentage as it prints on the document: 0.0975 becomes "9.750%". */
export function formatTaxRate(rate: number): string {
  return `${(rate * 100).toFixed(3)}%`
}
