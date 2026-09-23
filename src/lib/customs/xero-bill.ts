import { roundCents, wholeDollars } from '@/lib/customs/fees'
import { chargeLabel, customsChargeOf, serviceChargesOf, type CustomsCharge, type CustomsPackage } from '@/lib/customs/nippon-invoice'

/**
 * A Nippon Express invoice as Dave enters it in Xero, Echo Barrier USA LLC.
 *
 * Read off the 31 bills on 23 Sep 2026: contact "Nippon Express USA , Inc", Nippon's invoice
 * number as the bill number, no tax, one line per Group invoice ("Duty EBGS202610039") coded to
 * that product's inventory clearing account (07-0150 ICA H9B, 07-0152 ICA Cutting Stations / M1
 * and so on), exam and demurrage on their own line to 07-5210, container delivery to 07-5232.
 * Nippon's small handling charges (ISF, forwarding, brokerage, documents) ride in the duty lines.
 *
 * The inventory clearing account comes from the Group bill itself: EBGS202610039 is coded to
 * 07-0150 in Xero, so its duty is too. That is what lets the "Inventory Clearing Dummy Invoice"
 * clear each account to zero when the stock comes in at landed cost. The duty on EBGS202610040
 * (a compact cutting station) went to 07-0156 by hand, while the bill itself sat on 07-0152;
 * taking the account from the Group bill is what stops that.
 *
 * Pure: the Group bills are read from Xero by n8n and passed in.
 */

export const NIPPON_CONTACT = {
  id: 'f0109ec4-0741-4dfe-bdd0-9d774d794bd3',
  name: 'Nippon Express USA , Inc',
} as const

/** Cost Customs Clearance / Duty. */
export const CUSTOMS_CLEARANCE_ACCOUNT = '07-5210'
/** Cost - Container Transport to Baltimore. */
export const BALTIMORE_TRANSPORT_ACCOUNT = '07-5232'
/** Cost Container Transport, for anywhere else. */
export const CONTAINER_TRANSPORT_ACCOUNT = '07-5243'

/** Nippon's charges that Dave folds into the duty lines. */
const FOLDED = /isf|forwarding|handling|brokerage|documentation|document|other carrier/i
/** Charges that are moving the container, not clearing it. */
const TRANSPORT = /dray|deliver|cartage|trucking/i
/** Group bill lines that are not the goods: they carry no duty. */
const NOT_GOODS = /ship|deliver|freight|insuranc|transport|courier/i

export interface GroupBillLine {
  description: string
  amount: number
  accountCode: string | null
}

export interface GroupBill {
  number: string
  lines: GroupBillLine[]
}

export interface XeroBillLine {
  description: string
  quantity: 1
  unitAmount: number
  /** Null when the Hub cannot tell; the line says so and Dave picks it in Xero. */
  accountCode: string | null
  taxType: 'NONE'
}

export interface XeroBillDraft {
  contactId: string
  contactName: string
  invoiceNumber: string
  date: string
  /** The invoices say "PYTRM C.O.D."; the bills in Xero carry no fixed term. */
  dueDate: string
  currency: 'USD'
  lineAmountTypes: 'NoTax'
  lines: XeroBillLine[]
  total: number
  /** What Dave should look at before approving. */
  notes: string[]
}

export type Depot = 'US-BAL' | 'US-SBD'

/** Where the container was delivered: Jessup MD is Baltimore, Rancho Cucamonga is San Bernardino. */
export function depotFromDelivery(deliveredTo: string | null | undefined): Depot | null {
  const text = String(deliveredTo ?? '').toUpperCase()
  if (/JESSUP|BALTIMORE|\bMD\b/.test(text)) return 'US-BAL'
  if (/RANCHO CUCAMONGA|SAN BERNARDINO|FONTANA|\bCA\b/.test(text)) return 'US-SBD'
  return null
}

/** Share `total` in proportion to `weights`, to the cent, with the rounding left on the largest. */
export function allocate(total: number, weights: readonly number[]): number[] {
  const sum = weights.reduce((a, b) => a + b, 0)
  if (weights.length === 0) return []
  if (sum <= 0) return weights.map((_, i) => (i === 0 ? roundCents(total) : 0))
  const shares = weights.map((w) => roundCents((total * w) / sum))
  const drift = roundCents(total - shares.reduce((a, b) => a + b, 0))
  if (drift !== 0) {
    const largest = weights.indexOf(Math.max(...weights))
    shares[largest] = roundCents(shares[largest] + drift)
  }
  return shares
}

interface InvoiceShare {
  invoiceNumber: string | null
  duty: number
  enteredValue: number
}

function accountSplit(bill: GroupBill | undefined): { accountCode: string; weight: number }[] {
  if (!bill) return []
  const byAccount = new Map<string, number>()
  for (const line of bill.lines) {
    if (!line.accountCode || NOT_GOODS.test(line.description)) continue
    byAccount.set(line.accountCode, (byAccount.get(line.accountCode) ?? 0) + line.amount)
  }
  return [...byAccount.entries()].map(([accountCode, weight]) => ({ accountCode, weight }))
}

export function buildXeroBill(pkg: CustomsPackage, groupBills: readonly GroupBill[]): XeroBillDraft {
  const invoice = pkg.invoice
  const entry = pkg.entry
  const notes: string[] = []
  const container = pkg.waybill.container_numbers[0] ?? null
  const depot = depotFromDelivery(invoice.delivered_to)

  const service = serviceChargesOf(invoice)
  const folded = service.filter((c) => FOLDED.test(c.label))
  const separate = service.filter((c) => !FOLDED.test(c.label))
  const foldedTotal = roundCents(folded.reduce((sum, c) => sum + c.amount, 0))

  const lines: XeroBillLine[] = []

  if (!entry) {
    const customs = customsChargeOf(invoice)
    const amount = roundCents((customs?.amount ?? 0) + foldedTotal)
    lines.push({
      description: `Duty ${invoice.note ?? invoice.invoice_number}${container ? `, ${container}` : ''}`,
      quantity: 1,
      unitAmount: amount,
      accountCode: null,
      taxType: 'NONE',
    })
    notes.push('There is no entry summary in this PDF, so the duty could not be split by Group invoice. Choose the inventory clearing account in Xero.')
  } else {
    // One share per Group invoice, in the order the entry lists them.
    const shares: InvoiceShare[] = []
    for (const line of entry.lines) {
      const key = line.invoice_number ?? null
      let share = shares.find((s) => s.invoiceNumber === key)
      if (!share) {
        share = { invoiceNumber: key, duty: 0, enteredValue: 0 }
        shares.push(share)
      }
      share.duty = roundCents(share.duty + line.hts.reduce((sum, row) => sum + row.amount, 0))
      share.enteredValue += wholeDollars(line.entered_value)
    }
    const weights = shares.map((s) => s.enteredValue)
    const fees = allocate(entry.other_total, weights)
    const handling = allocate(foldedTotal, weights)

    shares.forEach((share, i) => {
      const amount = roundCents(share.duty + fees[i] + handling[i])
      const bill = share.invoiceNumber ? groupBills.find((b) => b.number === share.invoiceNumber) : undefined
      const accounts = accountSplit(bill)
      const label = `Duty ${share.invoiceNumber ?? 'unnumbered invoice'}${container ? `, ${container}` : ''}`
      if (accounts.length === 0) {
        lines.push({ description: label, quantity: 1, unitAmount: amount, accountCode: null, taxType: 'NONE' })
        notes.push(
          bill
            ? `${share.invoiceNumber} has no coded goods lines in Xero, so its duty has no inventory clearing account. Choose one in Xero.`
            : `${share.invoiceNumber ?? 'A line with no invoice number'} was not found among the Group's bills in Xero. Choose the inventory clearing account in Xero.`,
        )
        return
      }
      const parts = allocate(amount, accounts.map((a) => a.weight))
      accounts.forEach((a, j) =>
        lines.push({
          description: accounts.length > 1 ? `${label} (${a.accountCode})` : label,
          quantity: 1,
          unitAmount: parts[j],
          accountCode: a.accountCode,
          taxType: 'NONE',
        }),
      )
      if (accounts.length > 1) {
        notes.push(
          `${share.invoiceNumber} is spread over ${accounts.length} inventory clearing accounts, so its duty is split by the value of each product. Frames pay far more duty than panels; adjust in Xero if the split should follow the goods.`,
        )
      }
    })
  }

  for (const charge of separate) lines.push(separateLine(charge, depot))

  const total = roundCents(lines.reduce((sum, l) => sum + l.unitAmount, 0))
  if (Math.abs(total - invoice.total) > 0.005) {
    notes.push(`The lines add up to ${total.toFixed(2)}, the invoice total is ${invoice.total.toFixed(2)}.`)
  }

  return {
    contactId: NIPPON_CONTACT.id,
    contactName: NIPPON_CONTACT.name,
    invoiceNumber: invoice.invoice_number,
    date: invoice.invoice_date,
    dueDate: invoice.invoice_date,
    currency: 'USD',
    lineAmountTypes: 'NoTax',
    lines,
    total,
    notes,
  }
}

function separateLine(charge: CustomsCharge, depot: Depot | null): XeroBillLine {
  const transport = TRANSPORT.test(charge.label)
  const accountCode = transport
    ? depot === 'US-BAL'
      ? BALTIMORE_TRANSPORT_ACCOUNT
      : CONTAINER_TRANSPORT_ACCOUNT
    : CUSTOMS_CLEARANCE_ACCOUNT
  return { description: chargeLabel(charge.label), quantity: 1, unitAmount: roundCents(charge.amount), accountCode, taxType: 'NONE' }
}
