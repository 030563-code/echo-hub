import Link from 'next/link'
import { redirect } from 'next/navigation'
import { AlertCircle, FileText } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { getAuthorizedUser } from '@/lib/authz'
import { createAdminClient } from '@/lib/supabase/admin'
import { INVOICE_STAGES, type CustomerInvoiceStatus, type InvoiceStage } from '@/lib/customer-invoice/constants'
import { InvoiceStatusChip } from './status-chip'

/**
 * One stage of the invoicing pipeline as a worklist.
 *
 * Five pages share this, one per status in INVOICE_STAGES. The queue is a
 * plain `status = ?` read on purpose: completing a step is what moves an
 * invoice out of one queue and into the next, so an invoice is in exactly one
 * of these at any moment and "what is waiting for me" is answerable by looking
 * at a tab rather than by filtering a single list.
 *
 * The five pages were nearly byte-identical when written out separately, and
 * five copies of a queue are five places for the columns to drift.
 */

const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' })

/** What a rep does next with anything sitting in this queue. */
const NEXT_STEP: Record<CustomerInvoiceStatus, string> = {
  draft: 'Add the tax to move this on.',
  tax_calculated: 'Preview the invoice, then send the order to TaxJar. That allocates the EBUS number.',
  filed: 'Filed and numbered. Generate the invoice PDF next.',
  documented: 'The document exists. Email it to the customer next.',
  sent: 'The customer has it. Send it to Xero and attach the PDF to close it out.',
  authorizing: 'Being sent to Xero. If this has not settled in ten minutes, reconcile it.',
  completed: 'Done. In Xero with the PDF attached.',
  raised: 'Legacy status from the old order. Open it to see where it actually stands.',
  authorized: 'Legacy status from the old order. Open it to see where it actually stands.',
  voided: 'Discarded.',
}

/** The button reads as the step it opens, so the row says what happens next
 *  rather than a uniform "View". */
const ACTION_LABEL: Record<CustomerInvoiceStatus, string> = {
  draft: 'Open',
  tax_calculated: 'Preview and file',
  filed: 'Generate PDF',
  documented: 'Email to customer',
  sent: 'Send to Xero',
  authorizing: 'Reconcile',
  completed: 'View invoice',
  raised: 'Open',
  authorized: 'Open',
  voided: 'Open',
}

export async function InvoiceStageQueue({ stage }: { stage: InvoiceStage }) {
  const auth = await getAuthorizedUser()
  if (!auth.ok || !(auth.capabilities.has('invoicing.view') || auth.capabilities.has('invoicing.manage'))) {
    redirect('/')
  }

  const admin = createAdminClient()
  const { data: invoices, error } = await admin
    .from('customer_invoices')
    .select(
      'id, hubspot_deal_id, invoice_number, holding_reference, status, company_name, subtotal, shipping_total, total, updated_at',
    )
    .eq('status', stage.status)
    .order('updated_at', { ascending: false })
    .limit(200)

  const rows = (invoices ?? []).map((inv) => ({
    id: String(inv.id),
    dealId: String(inv.hubspot_deal_id),
    // The customer-facing number once it exists, the internal holding
    // reference before that. Never blank: a row you cannot name is a row you
    // cannot talk about.
    number: String(inv.invoice_number ?? inv.holding_reference),
    numbered: inv.invoice_number !== null,
    status: inv.status as CustomerInvoiceStatus,
    company: inv.company_name ? String(inv.company_name) : null,
    total:
      inv.total === null
        ? inv.subtotal === null
          ? null
          : Number(inv.subtotal) + Number(inv.shipping_total ?? 0)
        : Number(inv.total),
    taxed: inv.total !== null,
    updatedAt: String(inv.updated_at),
  }))

  const position = INVOICE_STAGES.findIndex((s) => s.status === stage.status) + 1

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">{stage.label}</h1>
        <p className="text-gray-500 text-sm mt-1">
          Step {position} of {INVOICE_STAGES.length}. {NEXT_STEP[stage.status]}
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
        <Card className="bg-white border-gray-200 p-10 text-center text-gray-500">
          <FileText className="w-8 h-8 mx-auto mb-3 text-gray-300" />
          <p className="font-medium text-gray-700">Nothing waiting here</p>
          <p className="text-sm mt-1">
            An invoice appears in this queue when it reaches {stage.label.toLowerCase()}, and leaves it on the next step.
          </p>
        </Card>
      ) : (
        <>
          <Card className="bg-white border-gray-200 hidden md:block overflow-x-auto p-0">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-200 text-left text-xs font-semibold uppercase tracking-wide text-gray-700">
                  <th className="px-4 py-3">Invoice</th>
                  <th className="px-4 py-3">Company</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3 text-right">Total</th>
                  <th className="px-4 py-3">Updated</th>
                  <th className="px-4 py-3 text-right">Action</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id} className="border-b border-gray-100 last:border-0 hover:bg-gray-50">
                    <td className="px-4 py-3">
                      <Link href={`/invoicing/${row.dealId}`} className="font-medium text-gray-900 hover:text-echo-orange">
                        {row.number}
                      </Link>
                      {!row.numbered && <span className="ml-2 text-xs text-gray-400">holding ref</span>}
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
                    {/* Every queue row ends in the same button in the same
                        place. Before this the stage queues only linked the
                        invoice number, so Accepted Quotes had an action on the
                        right and these did not. */}
                    <td className="px-4 py-3 text-right">
                      <Link
                        href={`/invoicing/${row.dealId}`}
                        className="inline-flex items-center whitespace-nowrap rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:border-echo-orange hover:text-gray-900"
                      >
                        {ACTION_LABEL[stage.status]}
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>

          <div className="md:hidden space-y-3">
            {rows.map((row) => (
              <Link key={row.id} href={`/invoicing/${row.dealId}`} className="block">
                <Card className="bg-white border-gray-200 p-4 space-y-1.5 hover:border-echo-orange">
                  <div className="flex items-start justify-between gap-2">
                    <p className="font-medium text-gray-900">{row.number}</p>
                    <InvoiceStatusChip chip={row.status} />
                  </div>
                  <p className="text-sm text-gray-500">
                    {row.company ?? 'No company'} ·{' '}
                    {row.total === null ? 'no total yet' : `${money.format(row.total)}${row.taxed ? '' : ' ex tax'}`}
                  </p>
                  <p className="pt-1 text-sm font-medium text-echo-orange">{ACTION_LABEL[stage.status]}</p>
                </Card>
              </Link>
            ))}
          </div>
        </>
      )}
    </div>
  )
}
