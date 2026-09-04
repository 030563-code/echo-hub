import { redirect, notFound } from 'next/navigation'
import { Card } from '@/components/ui/card'
import { getAuthorizedUser } from '@/lib/authz'
import { createAdminClient } from '@/lib/supabase/admin'
import { sourceLinesHash } from '@/lib/customer-invoice/hash'
import type { CustomerInvoiceLineRow, CustomerInvoiceRow } from '@/app/actions/invoicing/shared'
import { getAcceptedAt, isAcceptedSinceCutover } from '@/app/actions/invoicing/shared'
import { US_ACCEPTED_DEAL_STATUS, isUSDepot } from '@/lib/customer-invoice/constants'
import { OpenInvoiceButton } from '../open-invoice-button'
import { InvoiceEditor } from './invoice-editor'
import { InvoiceAttachments } from '@/components/invoicing/invoice-attachments'
import type { InvoiceAttachmentRow } from '@/app/actions/invoicing/attachments'
import { listDeliveryAddresses } from '@/lib/customer-invoice/delivery-address-store'
import { deliveryContactKey } from '@/lib/customer-invoice/delivery-address-book'

export const dynamic = 'force-dynamic'

export default async function InvoiceDetailPage({ params }: { params: Promise<{ dealId: string }> }) {
  const { dealId } = await params
  if (!/^\d+$/.test(dealId)) notFound()

  const auth = await getAuthorizedUser()
  if (!auth.ok || !(auth.capabilities.has('invoicing.view') || auth.capabilities.has('invoicing.manage'))) {
    redirect('/')
  }
  const canManage = auth.capabilities.has('invoicing.manage')

  const admin = createAdminClient()
  const { data: deal } = await admin
    .from('deals_registry')
    .select('hubspot_deal_id, deal_name, deal_status, quote_reference, depot_code, amount, line_items_raw')
    .eq('hubspot_deal_id', dealId)
    .maybeSingle()

  const { data: invoice } = await admin
    .from('customer_invoices')
    .select('*')
    .eq('hubspot_deal_id', dealId)
    .neq('status', 'voided')
    .maybeSingle()

  if (!deal && !invoice) notFound()

  // Without an invoice, this page is only meaningful for a deal that is
  // actually invoiceable. Checking it here keeps the page consistent with what
  // openInvoiceForDeal will allow, and stops the registry being browsable deal
  // by deal through the URL.
  if (!invoice) {
    const eligible =
      deal &&
      String(deal.deal_status ?? '') === US_ACCEPTED_DEAL_STATUS &&
      isUSDepot(String(deal.depot_code ?? '').trim().toUpperCase()) &&
      isAcceptedSinceCutover((await getAcceptedAt([dealId])).get(dealId))
    if (!eligible) notFound()
  }

  if (!invoice) {
    return (
      <div className="max-w-2xl space-y-4">
        <h1 className="text-2xl font-bold text-gray-900">{String(deal?.deal_name ?? dealId)}</h1>
        <Card className="bg-white border-gray-200 p-6 space-y-3">
          <p className="text-gray-700">No draft invoice exists for this deal yet.</p>
          <p className="text-sm text-gray-500">
            Building one copies the accepted quote&apos;s line items (fitting kits split into hooks and bungees),
            the delivery address and the Xero account code into an editable draft.
          </p>
          {canManage ? (
            <OpenInvoiceButton dealId={dealId} hasInvoice={false} />
          ) : (
            <p className="text-sm text-amber-700">You have view-only access; ask an admin to build the draft.</p>
          )}
        </Card>
      </div>
    )
  }

  const { data: lines } = await admin
    .from('customer_invoice_lines')
    .select('*')
    .eq('invoice_id', invoice.id)
    .order('sort_order', { ascending: true })

  const linesChanged = deal ? sourceLinesHash(deal.line_items_raw) !== sourceLinesHash(invoice.source_lines_snapshot) : false

  // invoice_attachments is service-role only (no grant, no policy), and the
  // capability check above has already run, so the admin client is the right
  // reader here and RLS has nothing to add.
  const { data: attachmentRows } = await admin
    .from('invoice_attachments')
    .select('id, filename, storage_path, content_type, size_bytes, uploaded_by_label, created_at')
    .eq('invoice_id', invoice.id)
    .order('created_at', { ascending: true })

  // The customer's remembered ship-to addresses, read server-side so the picker
  // is populated on first paint. A customer with neither a Xero account code nor
  // a HubSpot company resolves to no key and therefore no book, and the editor
  // hides the picker entirely.
  const savedAddresses = await listDeliveryAddresses(
    deliveryContactKey(
      invoice.taxjar_customer_id as string | null,
      invoice.hubspot_company_id as string | null,
    ),
  )

  return (
    <>
    <InvoiceEditor
      // The editor holds the draft in local state. Keying it on the row's id +
      // updated_at remounts it whenever the server copy changes (after a save,
      // a tax calculation, a send, or a rebuild), so the form can never keep
      // showing stale lines or a stale status after router.refresh().
      key={`${invoice.id}-${invoice.updated_at}`}
      invoice={invoice as CustomerInvoiceRow}
      lines={(lines ?? []) as CustomerInvoiceLineRow[]}
      dealName={String(deal?.deal_name ?? dealId)}
      quoteReference={deal?.quote_reference ? String(deal.quote_reference) : null}
      linesChanged={linesChanged}
      canManage={canManage}
      savedAddresses={savedAddresses}
    />
    <div className="mt-6">
      <InvoiceAttachments
        invoiceId={invoice.id as string}
        attachments={(attachmentRows ?? []) as InvoiceAttachmentRow[]}
        canManage={canManage}
      />
    </div>
    </>
  )
}
