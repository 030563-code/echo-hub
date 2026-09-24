import { HMF_RATE, roundCents, wholeDollars } from '@/lib/customs/fees'
import { allocate } from '@/lib/customs/xero-bill'
import { customsChargeOf, serviceChargesOf, type CustomsPackage } from '@/lib/customs/nippon-invoice'

/**
 * What each product on a shipment cost to land, and so what one barrier cost.
 *
 * Dean, 24 Sep 2026, on how Dave works it: "taking the delivery cost total from the commercial
 * invoice then dividing it by the total number of pallets and multiplying it by the pallets per
 * product ... He then takes all the invoice barrier costs + delivery cost + palletsing + insurance
 * + duty + clearance etc. and then divides it by the number of barriers to get the unit cost per
 * barrier. He then raises a PO with these unit costs."
 *
 * The rules, read off his tabs and Group's invoices in Xero USA:
 *
 *  - A commercial invoice (EBGS..., from Group) carries the barriers at their price and, for the
 *    container, palletising, delivery and insurance. Those three are shared among the products on
 *    that invoice by pallets, which is why two products of four pallets each show the same figure.
 *    An invoice in euros is converted at the rate Xero holds for the bill: "1 USD = 0.85 EUR"
 *    means dollars are euros divided by 0.85, each amount rounded to the cent.
 *  - CBP's entry summary gives one line per Group invoice, with its own duty and processing fee,
 *    and the harbour fee is 0.125% of each line's value. So those three follow the invoice they
 *    were charged on; inside an invoice with several products, and for anything typed by hand,
 *    they go by value (the barriers plus their palletising, which is what duty is charged on).
 *  - Nippon's "duty disbursement" (Dave's deferment fee, 3% of what CBP charged) follows the duty
 *    and fees. Nippon's other charges and the container's delivery to the depot go by pallets.
 *  - The unit cost is the total over the quantity. A Xero PO line carries it to four decimals
 *    (123.4567), so the PO's amount can sit a cent or two from the total; that is shown.
 *
 * Pure: the page, the actions and the tests all come here.
 */

export type PartKey =
  | 'goods'
  | 'palletising'
  | 'delivery'
  | 'insurance'
  | 'invoiceOther'
  | 'duty'
  | 'mpf'
  | 'hmf'
  | 'disbursement'
  | 'clearance'
  | 'containerDelivery'
  | 'other'

export const PARTS: readonly { key: PartKey; label: string }[] = [
  { key: 'goods', label: 'Barrier cost' },
  { key: 'palletising', label: 'Palletising' },
  { key: 'delivery', label: 'Delivery' },
  { key: 'insurance', label: 'Insurance' },
  { key: 'invoiceOther', label: 'Other on the invoice' },
  { key: 'duty', label: 'Duty' },
  { key: 'mpf', label: 'Processing fee (MPF)' },
  { key: 'hmf', label: 'Harbour fee (HMF)' },
  { key: 'disbursement', label: 'Duty disbursement' },
  { key: 'clearance', label: 'Clearance charges' },
  { key: 'containerDelivery', label: 'Container delivery' },
  { key: 'other', label: 'Other' },
]

export type LocalKey = 'duty' | 'mpf' | 'hmf' | 'disbursement' | 'clearance' | 'containerDelivery' | 'other'
export const LOCAL_KEYS: readonly LocalKey[] = ['duty', 'mpf', 'hmf', 'disbursement', 'clearance', 'containerDelivery', 'other']

export interface CostInvoice {
  id: string
  number: string
  currency: string
  /** Units of the invoice's currency to one unit of the landed currency, as Xero shows the bill's
   *  rate. Null when the invoice is already in the landed currency. */
  rate: number | null
  palletising: number
  delivery: number
  insurance: number
  otherAmount: number
}

export interface CostLine {
  id: string
  productCode: string
  quantity: number
  pallets: number | null
  invoiceId: string | null
  /** The line's amount on its commercial invoice, in that invoice's currency. */
  goodsAmount: number | null
}

/** One local cost: its total and, from an entry summary, how much of it each Group invoice carries. */
export interface LocalPart {
  total: number
  byInvoice?: readonly { invoiceNumber: string; amount: number }[]
}

export type LocalCosts = Partial<Record<LocalKey, LocalPart | null>>

export interface LandedLine {
  lineId: string
  productCode: string
  quantity: number
  pallets: number | null
  parts: Record<PartKey, number>
  total: number
  /** Null until the line's commercial invoice amount is known. */
  unitCost: number | null
  /** The unit cost to four decimals, as a Xero PO line carries it. */
  xeroUnit: number | null
  /** What that unit gives on the PO line. */
  xeroAmount: number | null
}

export interface LandedResult {
  currency: string
  lines: LandedLine[]
  totals: Record<PartKey, number>
  total: number
  /** What stops it being final, in words. Empty when every figure is in. */
  missing: string[]
  /** A cost that could not be shared the usual way, and what was done instead. */
  notes: string[]
}

/** 12,345.67 */
export const formatMoney = (n: number) => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
/** 123.4567, the way a Xero PO line carries a unit cost. */
export const formatUnit = (n: number) => n.toLocaleString('en-US', { minimumFractionDigits: 4, maximumFractionDigits: 4 })

const zeroParts = (): Record<PartKey, number> =>
  Object.fromEntries(PARTS.map((p) => [p.key, 0])) as Record<PartKey, number>

const round4 = (n: number) => Math.round(n * 10_000) / 10_000

/** Group's invoice numbers as CBP prints them, which sometimes drops the series ("202600001"). */
export function sameInvoice(a: string, b: string): boolean {
  const x = a.toUpperCase().replace(/[^A-Z0-9]/g, '')
  const y = b.toUpperCase().replace(/[^A-Z0-9]/g, '')
  if (!x || !y) return false
  if (x === y) return true
  const [short, long] = x.length < y.length ? [x, y] : [y, x]
  return short.length >= 6 && long.endsWith(short)
}

/** An amount in the landed currency, or null when the invoice has no rate to convert it with. */
export function toLanded(amount: number, invoice: Pick<CostInvoice, 'currency' | 'rate'>, currency: string): number | null {
  if (invoice.currency === currency) return roundCents(amount)
  if (!(invoice.rate != null && invoice.rate > 0)) return null
  return roundCents(amount / invoice.rate)
}

/** Pallets where every line has some, otherwise the quantities. */
function palletWeights(lines: readonly CostLine[]): { weights: number[]; byPallets: boolean } {
  const pallets = lines.map((l) => l.pallets ?? 0)
  if (lines.length && pallets.every((p) => p > 0)) return { weights: pallets, byPallets: true }
  return { weights: lines.map((l) => l.quantity), byPallets: false }
}

function addShares(target: Record<PartKey, number>[], indexes: readonly number[], key: PartKey, shares: readonly number[]) {
  indexes.forEach((i, j) => {
    target[i][key] = roundCents(target[i][key] + shares[j])
  })
}

export function landedCost(input: {
  currency: string
  lines: readonly CostLine[]
  invoices: readonly CostInvoice[]
  local: LocalCosts
}): LandedResult {
  const { currency, lines, invoices, local } = input
  const parts = lines.map(zeroParts)
  const missing: string[] = []
  const notes: string[] = []
  const labelOf = (key: PartKey) => PARTS.find((p) => p.key === key)!.label.toLowerCase()
  const all = lines.map((_, i) => i)

  // What each commercial invoice carries, converted, and its container charges by pallets.
  const unconvertible = new Set<string>()
  for (const inv of invoices) {
    const on = all.filter((i) => lines[i].invoiceId === inv.id)
    if (toLanded(1, inv, currency) == null) {
      unconvertible.add(inv.id)
      missing.push(`the exchange rate on ${inv.number}`)
      continue
    }
    for (const i of on) {
      const amount = lines[i].goodsAmount
      if (amount != null) parts[i].goods = toLanded(amount, inv, currency) ?? 0
    }
    const charges: [PartKey, number][] = [
      ['palletising', inv.palletising],
      ['delivery', inv.delivery],
      ['insurance', inv.insurance],
      ['invoiceOther', inv.otherAmount],
    ]
    for (const [key, amount] of charges) {
      if (!amount) continue
      if (!on.length) {
        notes.push(`${inv.number} has no products on it yet, so its ${labelOf(key)} is in no unit cost.`)
        continue
      }
      const { weights, byPallets } = palletWeights(on.map((i) => lines[i]))
      if (!byPallets && on.length > 1) notes.push(`Not every product on ${inv.number} has its pallets, so its ${labelOf(key)} is shared by quantity.`)
      addShares(parts, on, key, allocate(toLanded(amount, inv, currency) ?? 0, weights))
    }
  }

  for (const line of lines) {
    const invoice = invoices.find((inv) => inv.id === line.invoiceId)
    if (!invoice || line.goodsAmount == null) missing.push(`the ${line.productCode} line's amount on its commercial invoice`)
  }
  const valueKnown = lines.every((l) => {
    const invoice = invoices.find((inv) => inv.id === l.invoiceId)
    return invoice && l.goodsAmount != null && !unconvertible.has(invoice.id)
  })

  // The value duty is charged on: the barriers and their palletising.
  const value = (indexes: readonly number[]) => indexes.map((i) => parts[i].goods + parts[i].palletising)
  const byValue = (indexes: readonly number[]) => {
    const weights = value(indexes)
    return valueKnown && weights.some((w) => w > 0) ? weights : palletWeights(indexes.map((i) => lines[i])).weights
  }

  // Duty and the two fees: each Group invoice's share from the entry, the rest by value.
  for (const key of ['duty', 'mpf', 'hmf'] as const) {
    const part = local[key]
    if (!part || !part.total || !lines.length) continue
    let remaining = part.total
    for (const share of part.byInvoice ?? []) {
      const invoice = invoices.find((inv) => sameInvoice(inv.number, share.invoiceNumber))
      const on = invoice ? all.filter((i) => lines[i].invoiceId === invoice.id) : []
      if (!on.length) {
        notes.push(`The entry charges ${key === 'duty' ? 'duty' : labelOf(key)} on ${share.invoiceNumber}, which none of these products is on, so that part is shared across every product by value.`)
        continue
      }
      addShares(parts, on, key, allocate(share.amount, byValue(on)))
      remaining -= share.amount
    }
    remaining = roundCents(remaining)
    if (remaining !== 0) addShares(parts, all, key, allocate(remaining, byValue(all)))
  }
  if (!valueKnown && (['duty', 'mpf', 'hmf'] as const).some((k) => local[k]?.total)) {
    notes.push('Until every product has its invoice amount, the duty and fees are shared by pallets.')
  }

  // The disbursement is a percentage of what CBP charged, so it follows those.
  const disbursement = local.disbursement?.total ?? 0
  if (disbursement && lines.length) {
    const cbp = all.map((i) => parts[i].duty + parts[i].mpf + parts[i].hmf)
    addShares(parts, all, 'disbursement', allocate(disbursement, cbp.some((c) => c > 0) ? cbp : byValue(all)))
  }

  // Everything else that moved or cleared the container, by pallets.
  for (const key of ['clearance', 'containerDelivery', 'other'] as const) {
    const amount = local[key]?.total ?? 0
    if (!amount || !lines.length) continue
    const { weights, byPallets } = palletWeights(lines)
    if (!byPallets && lines.length > 1) notes.push(`Not every product has its pallets, so the ${labelOf(key)} is shared by quantity.`)
    addShares(parts, all, key, allocate(amount, weights))
  }

  const landed: LandedLine[] = lines.map((l, i) => {
    const total = roundCents(PARTS.reduce((sum, p) => sum + parts[i][p.key], 0))
    const known = Boolean(l.invoiceId && l.goodsAmount != null && !unconvertible.has(l.invoiceId ?? ''))
    const unitCost = known && l.quantity > 0 ? total / l.quantity : null
    const xeroUnit = unitCost == null ? null : round4(unitCost)
    return {
      lineId: l.id,
      productCode: l.productCode,
      quantity: l.quantity,
      pallets: l.pallets,
      parts: parts[i],
      total,
      unitCost,
      xeroUnit,
      xeroAmount: xeroUnit == null ? null : roundCents(xeroUnit * l.quantity),
    }
  })

  const totals = zeroParts()
  for (const line of landed) for (const p of PARTS) totals[p.key] = roundCents(totals[p.key] + line.parts[p.key])
  return {
    currency,
    lines: landed,
    totals,
    total: roundCents(landed.reduce((sum, l) => sum + l.total, 0)),
    missing: [...new Set(missing)],
    notes: [...new Set(notes)],
  }
}

// ---------------------------------------------------------------------------
// Nippon's bills
// ---------------------------------------------------------------------------

/** Charges that are moving the container, not clearing it (as on the Xero bill). */
const TRANSPORT = /dray|deliver|cartage|trucking/i
/** Nippon's fee for paying the duty, 3% of it: Dave's "deferment fee". */
const DISBURSEMENT = /disburs|defer/i

export interface BillCosts {
  local: LocalCosts
  /** An entry summary was read, so duty and the fees are CBP's own figures. */
  hasEntry: boolean
  notes: string[]
}

/**
 * What Nippon billed for a shipment, as local costs: CBP's duty and fees per Group invoice from
 * the entry lines, the disbursement fee, and the rest of Nippon's charges.
 */
export function costsFromBills(pkgs: readonly CustomsPackage[]): BillCosts | null {
  if (!pkgs.length) return null
  const shares: Record<'duty' | 'mpf' | 'hmf', Map<string, number>> = { duty: new Map(), mpf: new Map(), hmf: new Map() }
  const totals: Record<LocalKey, number> = { duty: 0, mpf: 0, hmf: 0, disbursement: 0, clearance: 0, containerDelivery: 0, other: 0 }
  const notes: string[] = []
  let hasEntry = false

  const add = (key: 'duty' | 'mpf' | 'hmf', invoiceNumber: string, amount: number) => {
    shares[key].set(invoiceNumber, roundCents((shares[key].get(invoiceNumber) ?? 0) + amount))
  }

  for (const pkg of pkgs) {
    const entry = pkg.entry
    if (entry) {
      hasEntry = true
      const numberOf = (i: number) => entry.lines[i].invoice_number ?? `line ${entry.lines[i].line_no}`
      const evs = entry.lines.map((l) => wholeDollars(l.entered_value))

      const duties = entry.lines.map((l) => roundCents(l.hts.reduce((sum, row) => sum + row.amount, 0)))
      const duty = roundCents(entry.duty_total + (entry.tax_total ?? 0))
      allocate(duty, duties.some((d) => d > 0) ? duties : evs).forEach((a, i) => add('duty', numberOf(i), a))
      totals.duty = roundCents(totals.duty + duty)

      const lineMpfs = entry.lines.map((l) => l.mpf ?? 0)
      const mpf = entry.mpf_total ?? roundCents(lineMpfs.reduce((a, b) => a + b, 0))
      if (mpf) allocate(mpf, lineMpfs.some((m) => m > 0) ? lineMpfs : evs).forEach((a, i) => add('mpf', numberOf(i), a))
      totals.mpf = roundCents(totals.mpf + mpf)

      const hmf = entry.hmf_total ?? roundCents(evs.reduce((sum, ev) => sum + roundCents(ev * HMF_RATE), 0))
      if (hmf) allocate(hmf, evs.map((ev) => roundCents(ev * HMF_RATE))).forEach((a, i) => add('hmf', numberOf(i), a))
      totals.hmf = roundCents(totals.hmf + hmf)
    } else {
      const customs = customsChargeOf(pkg.invoice)
      if (customs) {
        totals.duty = roundCents(totals.duty + customs.amount)
        notes.push(
          `${pkg.invoice.invoice_number} has no entry summary, so its ${customs.amount.toFixed(2)} of duty and fees is counted as duty.`,
        )
      }
    }
    for (const charge of serviceChargesOf(pkg.invoice)) {
      const key: LocalKey = DISBURSEMENT.test(charge.label) ? 'disbursement' : TRANSPORT.test(charge.label) ? 'containerDelivery' : 'clearance'
      totals[key] = roundCents(totals[key] + charge.amount)
    }
  }

  const part = (key: LocalKey): LocalPart | null => {
    if (!totals[key]) return null
    const by = key === 'duty' || key === 'mpf' || key === 'hmf' ? shares[key] : null
    return {
      total: totals[key],
      ...(by && by.size ? { byInvoice: [...by.entries()].map(([invoiceNumber, amount]) => ({ invoiceNumber, amount })) } : {}),
    }
  }
  return {
    local: Object.fromEntries(LOCAL_KEYS.map((k) => [k, part(k)])) as LocalCosts,
    hasEntry,
    notes,
  }
}

export type LocalSource = 'bill' | 'typed' | null

/**
 * The local costs the calculation uses: Nippon's bill where it has the figure, what was typed where
 * it does not. Duty and the two fees are CBP's whenever the bill has them, even at zero: from an
 * entry summary, or inside the one "duty/fees" charge when the entry is missing, so a fee typed by
 * hand is never counted a second time. The other charges take the bill's figure only when the bill
 * carries one, so a trucker's delivery typed by hand still counts when Nippon did not deliver.
 */
export function effectiveLocalCosts(
  typed: Partial<Record<LocalKey, number | null>>,
  bills: BillCosts | null,
): { local: LocalCosts; source: Record<LocalKey, LocalSource> } {
  const local: LocalCosts = {}
  const source = {} as Record<LocalKey, LocalSource>
  for (const key of LOCAL_KEYS) {
    const fromBill = bills?.local[key] ?? null
    const cbp = key === 'duty' || key === 'mpf' || key === 'hmf'
    const cbpOnBill = Boolean(bills && (bills.hasEntry || bills.local.duty))
    const billDecides = cbp ? cbpOnBill : Boolean(fromBill)
    if (billDecides) {
      local[key] = fromBill
      source[key] = 'bill'
      continue
    }
    const value = typed[key]
    local[key] = value ? { total: roundCents(value) } : null
    source[key] = value != null ? 'typed' : null
  }
  return { local, source }
}
