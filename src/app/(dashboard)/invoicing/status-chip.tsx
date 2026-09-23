import type { CustomerInvoiceStatus } from '@/lib/customer-invoice/constants'
import { filedChipLabel, type TaxEngine } from '@/lib/customer-invoice/invoicing-profile'

export type QueueChip = CustomerInvoiceStatus | 'new' | 'missing_address'

const CHIP_STYLES: Record<QueueChip, { label: string; className: string }> = {
  missing_address: { label: 'Missing address', className: 'bg-amber-100 text-amber-800' },
  new: { label: 'New', className: 'bg-blue-100 text-blue-800' },
  draft: { label: 'Draft', className: 'bg-slate-200 text-slate-800' },
  tax_calculated: { label: 'Tax calculated', className: 'bg-indigo-100 text-indigo-800' },
  filed: { label: 'Filed with TaxJar', className: 'bg-sky-100 text-sky-800' },
  documented: { label: 'PDF generated', className: 'bg-cyan-100 text-cyan-800' },
  sent: { label: 'Sent to customer', className: 'bg-green-100 text-green-800' },
  authorizing: { label: 'Sending to Xero…', className: 'bg-purple-100 text-purple-800' },
  completed: { label: 'In Xero, PDF attached', className: 'bg-emerald-100 text-emerald-800' },
  // Legacy, no longer written. Both belonged to the old order where Xero came
  // second; kept so a historical row still renders a chip rather than crashing.
  raised: { label: 'Raised (legacy)', className: 'bg-gray-200 text-gray-700' },
  authorized: { label: 'Authorized (legacy)', className: 'bg-gray-200 text-gray-700' },
  voided: { label: 'Discarded', className: 'bg-gray-200 text-gray-700' },
}

/**
 * `taxEngine` is the invoicing organisation's. One chip reads differently by
 * it: a numbered USA invoice has been filed with TaxJar, a numbered French one
 * has only been numbered, and "Filed with TaxJar" on Claire's screen would
 * describe something that never happened. Callers that do not know the
 * organisation get the USA's words, as before.
 */
export function InvoiceStatusChip({ chip, taxEngine }: { chip: QueueChip; taxEngine?: TaxEngine }) {
  const style = CHIP_STYLES[chip] ?? CHIP_STYLES.draft
  const label = chip === 'filed' && taxEngine ? filedChipLabel(taxEngine) : style.label
  return (
    <span className={`inline-block whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${style.className}`}>
      {label}
    </span>
  )
}
