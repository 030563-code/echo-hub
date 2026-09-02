import type { CustomerInvoiceStatus } from '@/lib/customer-invoice/constants'

export type QueueChip = CustomerInvoiceStatus | 'new' | 'missing_address'

const CHIP_STYLES: Record<QueueChip, { label: string; className: string }> = {
  missing_address: { label: 'Missing address', className: 'bg-amber-100 text-amber-800' },
  new: { label: 'New', className: 'bg-blue-100 text-blue-800' },
  draft: { label: 'Draft', className: 'bg-gray-100 text-gray-700' },
  tax_calculated: { label: 'Tax calculated', className: 'bg-indigo-100 text-indigo-800' },
  authorizing: { label: 'Sending…', className: 'bg-purple-100 text-purple-800' },
  raised: { label: 'Raised', className: 'bg-sky-100 text-sky-800' },
  authorized: { label: 'Authorized', className: 'bg-green-100 text-green-800' },
  sent: { label: 'Sent', className: 'bg-green-100 text-green-800' },
  completed: { label: 'Recorded', className: 'bg-emerald-100 text-emerald-800' },
  voided: { label: 'Discarded', className: 'bg-gray-100 text-gray-500' },
}

export function InvoiceStatusChip({ chip }: { chip: QueueChip }) {
  const style = CHIP_STYLES[chip] ?? CHIP_STYLES.draft
  return (
    <span className={`inline-block whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${style.className}`}>
      {style.label}
    </span>
  )
}
