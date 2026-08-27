import { redirect } from 'next/navigation'
import { AlertCircle, Inbox } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { getAuthorizedUser } from '@/lib/authz'
import { createAdminClient } from '@/lib/supabase/admin'
import { US_ACCEPTED_DEAL_STATUS, US_DEPOTS, type CustomerInvoiceStatus } from '@/lib/customer-invoice/constants'
import { getAcceptedAt, isAcceptedSinceCutover } from '@/app/actions/invoicing/shared'
import { sourceLinesHash } from '@/lib/customer-invoice/hash'
import { sanitizeUSAddress } from '@/lib/us-address'
import { OpenInvoiceButton } from '../open-invoice-button'
import { InvoiceStatusChip, type QueueChip } from '../status-chip'

export const dynamic = 'force-dynamic'

interface QueueRow {
  dealId: string
  dealName: string
  companyId: string | null
  depot: string
  amount: number | null
  quoteRef: string | null
  updatedAt: string
  chip: QueueChip
  linesChanged: boolean
  invoiceNumber: string | null
}

const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' })

export default async function AcceptedQueuePage() {
  const auth = await getAuthorizedUser()
  if (!auth.ok || !(auth.capabilities.has('invoicing.view') || auth.capabilities.has('invoicing.manage'))) {
    redirect('/')
  }

  const canManage = auth.capabilities.has('invoicing.manage')

  const admin = createAdminClient()
  const { data: deals, error } = await admin
    .from('deals_registry')
    .select(
      'hubspot_deal_id, deal_name, hubspot_company_id, depot_code, amount, quote_reference, line_items_raw, delivery_street, delivery_city, delivery_state, delivery_zip',
    )
    .eq('deal_status', US_ACCEPTED_DEAL_STATUS)
    .in('depot_code', [...US_DEPOTS])
    .limit(500)

  let rows: QueueRow[] = []
  if (!error && deals && deals.length > 0) {
    // Eligibility is dated from deal_stage_history, not deals_registry
    // .updated_at, which does not move when an acceptance syncs in.
    const acceptedAt = await getAcceptedAt(deals.map((d) => String(d.hubspot_deal_id)))
    const eligible = deals.filter((d) => isAcceptedSinceCutover(acceptedAt.get(String(d.hubspot_deal_id))))

    const { data: invoices } = eligible.length === 0 ? { data: [] } : await admin
      .from('customer_invoices')
      .select('hubspot_deal_id, status, invoice_number, xero_invoice_number, source_lines_snapshot')
      .in('hubspot_deal_id', eligible.map((d) => String(d.hubspot_deal_id)))
      .neq('status', 'voided')
    const invoiceByDeal = new Map((invoices ?? []).map((i) => [String(i.hubspot_deal_id), i]))

    rows = eligible.map((deal) => {
      const dealId = String(deal.hubspot_deal_id)
      const invoice = invoiceByDeal.get(dealId)
      const addressOk = sanitizeUSAddress({
        street: deal.delivery_street ?? '',
        city: deal.delivery_city ?? '',
        state: deal.delivery_state ?? '',
        zip: deal.delivery_zip ?? '',
      }).ok

      let chip: QueueChip
      if (!invoice) chip = addressOk ? 'new' : 'missing_address'
      else chip = invoice.status as CustomerInvoiceStatus

      const linesChanged = invoice
        ? sourceLinesHash(deal.line_items_raw) !== sourceLinesHash(invoice.source_lines_snapshot)
        : false

      return {
        dealId,
        dealName: String(deal.deal_name ?? dealId),
        companyId: deal.hubspot_company_id ? String(deal.hubspot_company_id) : null,
        depot: String(deal.depot_code),
        amount: deal.amount === null ? null : Number(deal.amount),
        quoteRef: deal.quote_reference ? String(deal.quote_reference) : null,
        updatedAt: acceptedAt.get(String(deal.hubspot_deal_id)) as string,
        chip,
        linesChanged,
        invoiceNumber: invoice ? String(invoice.xero_invoice_number ?? invoice.invoice_number) : null,
      }
    })
    rows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Accepted Quotes</h1>
        <p className="text-gray-500 text-sm mt-1">
          US quotes marked Quotation Accepted, waiting to be reviewed, taxed and invoiced.
        </p>
      </div>

      {error ? (
        <Card className="p-6 border-red-200 bg-red-50">
          <div className="flex items-center gap-3 text-red-800">
            <AlertCircle className="w-5 h-5" />
            <p className="font-medium">Error loading the accepted-quotes queue</p>
          </div>
        </Card>
      ) : rows.length === 0 ? (
        <Card className="p-10 text-center text-gray-500">
          <Inbox className="w-8 h-8 mx-auto mb-3 text-gray-300" />
          <p className="font-medium text-gray-700">No accepted US quotes yet</p>
          <p className="text-sm mt-1">
            Deals appear here a minute or two after a rep marks them Quotation Accepted (they arrive via the
            HubSpot sync).
          </p>
        </Card>
      ) : (
        <>
          {/* Table on md+, stacked cards below */}
          <Card className="hidden md:block overflow-x-auto p-0">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-200 text-left text-xs uppercase tracking-wide text-gray-500">
                  <th className="px-4 py-3">Deal</th>
                  <th className="px-4 py-3">Quote ref</th>
                  <th className="px-4 py-3">Depot</th>
                  <th className="px-4 py-3 text-right">Amount</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3">Accepted</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.dealId} className="border-b border-gray-100 last:border-0 hover:bg-gray-50">
                    <td className="px-4 py-3 font-medium text-gray-900">{row.dealName}</td>
                    <td className="px-4 py-3 text-gray-600">{row.quoteRef ?? '—'}</td>
                    <td className="px-4 py-3 text-gray-600">{row.depot}</td>
                    <td className="px-4 py-3 text-right tabular-nums text-gray-900">
                      {row.amount === null ? '—' : money.format(row.amount)}
                    </td>
                    <td className="px-4 py-3">
                      <span className="inline-flex items-center gap-1.5">
                        <InvoiceStatusChip chip={row.chip} />
                        {row.linesChanged && (
                          <span className="inline-block rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800">
                            Lines changed
                          </span>
                        )}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-gray-500">
                      {new Date(row.updatedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <OpenInvoiceButton
                  dealId={row.dealId}
                  hasInvoice={row.chip !== 'new' && row.chip !== 'missing_address'}
                  canManage={canManage}
                />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>

          <div className="md:hidden space-y-3">
            {rows.map((row) => (
              <Card key={row.dealId} className="p-4 space-y-2">
                <div className="flex items-start justify-between gap-2">
                  <p className="font-medium text-gray-900">{row.dealName}</p>
                  <InvoiceStatusChip chip={row.chip} />
                </div>
                <p className="text-sm text-gray-500">
                  {row.quoteRef ?? 'No quote ref'} · {row.depot} ·{' '}
                  {row.amount === null ? 'no amount' : money.format(row.amount)}
                </p>
                {row.linesChanged && (
                  <p className="text-xs font-medium text-amber-700">Lines changed on the deal since the draft was built</p>
                )}
                <OpenInvoiceButton
                  dealId={row.dealId}
                  hasInvoice={row.chip !== 'new' && row.chip !== 'missing_address'}
                  canManage={canManage}
                />
              </Card>
            ))}
          </div>
        </>
      )}
    </div>
  )
}
