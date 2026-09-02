import Link from 'next/link'
import { redirect } from 'next/navigation'
import { AlertCircle, FileText } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { getAuthorizedUser } from '@/lib/authz'
import { createAdminClient } from '@/lib/supabase/admin'
import type { CustomerInvoiceStatus } from '@/lib/customer-invoice/constants'
import { InvoiceStatusChip } from '../status-chip'

export const dynamic = 'force-dynamic'

const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' })

export default async function DraftInvoicesPage() {
  const auth = await getAuthorizedUser()
  if (!auth.ok || !(auth.capabilities.has('invoicing.view') || auth.capabilities.has('invoicing.manage'))) {
    redirect('/')
  }

  const admin = createAdminClient()
  const { data: invoices, error } = await admin
    .from('customer_invoices')
    .select(
      'id, hubspot_deal_id, invoice_number, holding_reference, status, company_name, subtotal, shipping_total, tax_total, total, updated_at',
    )
    .neq('status', 'voided')
    .order('updated_at', { ascending: false })
    .limit(200)

  const rows = (invoices ?? []).map((inv) => ({
    id: String(inv.id),
    dealId: String(inv.hubspot_deal_id),
    number: String(inv.invoice_number ?? inv.holding_reference),
    status: inv.status as CustomerInvoiceStatus,
    company: inv.company_name ? String(inv.company_name) : null,
    total: inv.total === null ? (inv.subtotal === null ? null : Number(inv.subtotal) + Number(inv.shipping_total ?? 0)) : Number(inv.total),
    taxed: inv.total !== null,
    updatedAt: String(inv.updated_at),
  }))

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Draft Invoices</h1>
        <p className="text-gray-500 text-sm mt-1">
          Every US customer invoice in flight: drafts, calculated tax, and what has gone to Xero.
        </p>
      </div>

      {error ? (
        <Card className="p-6 border-red-200 bg-red-50">
          <div className="flex items-center gap-3 text-red-800">
            <AlertCircle className="w-5 h-5" />
            <p className="font-medium">Error loading invoices</p>
          </div>
        </Card>
      ) : rows.length === 0 ? (
        <Card className="p-10 text-center text-gray-500">
          <FileText className="w-8 h-8 mx-auto mb-3 text-gray-300" />
          <p className="font-medium text-gray-700">No invoices yet</p>
          <p className="text-sm mt-1">Open an accepted quote to build its first draft.</p>
        </Card>
      ) : (
        <>
          <Card className="hidden md:block overflow-x-auto p-0">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-200 text-left text-xs uppercase tracking-wide text-gray-500">
                  <th className="px-4 py-3">Invoice</th>
                  <th className="px-4 py-3">Company</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3 text-right">Total</th>
                  <th className="px-4 py-3">Updated</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id} className="border-b border-gray-100 last:border-0 hover:bg-gray-50">
                    <td className="px-4 py-3">
                      <Link href={`/invoicing/${row.dealId}`} className="font-medium text-gray-900 hover:text-echo-orange">
                        {row.number}
                      </Link>
                    </td>
                    <td className="px-4 py-3 text-gray-600">{row.company ?? '—'}</td>
                    <td className="px-4 py-3">
                      <InvoiceStatusChip chip={row.status} />
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums text-gray-900">
                      {row.total === null ? '—' : money.format(row.total)}
                      {!row.taxed && row.total !== null && <span className="text-gray-400"> ex tax</span>}
                    </td>
                    <td className="px-4 py-3 text-gray-500">
                      {new Date(row.updatedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>

          <div className="md:hidden space-y-3">
            {rows.map((row) => (
              <Link key={row.id} href={`/invoicing/${row.dealId}`} className="block">
                <Card className="p-4 space-y-1.5 hover:border-echo-orange">
                  <div className="flex items-start justify-between gap-2">
                    <p className="font-medium text-gray-900">{row.number}</p>
                    <InvoiceStatusChip chip={row.status} />
                  </div>
                  <p className="text-sm text-gray-500">
                    {row.company ?? 'No company'} ·{' '}
                    {row.total === null ? 'no total yet' : `${money.format(row.total)}${row.taxed ? '' : ' ex tax'}`}
                  </p>
                </Card>
              </Link>
            ))}
          </div>
        </>
      )}
    </div>
  )
}
