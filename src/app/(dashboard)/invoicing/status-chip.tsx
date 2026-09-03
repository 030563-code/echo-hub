import type { CustomerInvoiceStatus } from '@/lib/customer-invoice/constants'

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

export function InvoiceStatusChip({ chip }: { chip: QueueChip }) {
  const style = CHIP_STYLES[chip] ?? CHIP_STYLES.draft
  return (
    <span className={`inline-block whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${style.className}`}>
      {style.label}
    </span>
  )
}
