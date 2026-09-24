import { redirect } from 'next/navigation'
import { AlertCircle, Inbox } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { getAuthorizedUser } from '@/lib/authz'
import { activeOrganisation } from '@/lib/active-organisation.server'
import { createAdminClient } from '@/lib/supabase/admin'
import { depotCode, depotLabel, depotQueryValues } from '@/lib/depot-constants'
import type { CustomerInvoiceStatus } from '@/lib/customer-invoice/constants'
import { depotsForOrg, orgLabel, organisation } from '@/lib/organisations'
import { invoicingProfile } from '@/lib/customer-invoice/invoicing-profile'
import { sanitizeDeliveryAddress } from '@/lib/delivery-address'
import { NoOrganisationCard } from '@/components/organisations/no-organisation-card'
import { getAcceptedSinceCutover, isNotInvoiceableStage } from '@/app/actions/invoicing/shared'
import { sourceLinesHash } from '@/lib/customer-invoice/hash'
import { OpenInvoiceButton } from '../open-invoice-button'
import { ExcludeFromQueueButton } from '../queue-exclusion-buttons'
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

export default async function AcceptedQueuePage() {
  const auth = await getAuthorizedUser()
  if (!auth.ok || !(auth.capabilities.has('invoicing.view') || auth.capabilities.has('invoicing.manage'))) {
    redirect('/')
  }

  const canManage = auth.capabilities.has('invoicing.manage')

  // The organisation being looked at decides the depots, and the depots go
  // into the query. Dean, 15 Sep 2026: every organisation is listed; the ones
  // with an invoicing profile (the USA, France since 22 Sep 2026, and Canada
  // since 24 Sep 2026 up to the tax step) can create an invoice here, the
  // others see their queue and cannot yet.
  const org = await activeOrganisation(auth)
  if (!org) return <NoOrganisationCard title="Accepted Quotes" what="accepted quotes" />
  const depots = depotsForOrg(org)
  const profile = invoicingProfile(org)
  const invoicingLive = profile !== null
  const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: organisation(org).currency })

  const admin = createAdminClient()

  // The queue is driven by deal_stage_history, NOT by the deal's current
  // stage. A deal only passes through Quotation Accepted, often for minutes,
  // and filtering on the current stage made every deal that moved on to Closed
  // Won disappear from here permanently. History also dates the acceptance
  // correctly, which deals_registry.updated_at does not.
  const acceptedAt = await getAcceptedSinceCutover()
  const acceptedIds = [...acceptedAt.keys()]

  // Deals held out of this queue on purpose: invoiced outside the Hub, or
  // raised here in error. They used to be listed at the bottom of the page
  // with an Undo. Dean, 11 Sep 2026: "no need for that exclusion list under
  // the accepted quotes, just take it out of sight." The rows stay in
  // invoicing_queue_exclusions as the record, and restoreDealToQueue still
  // puts one back; there is simply no panel for it here.
  const { data: exclusionRows } = await admin
    .from('invoicing_queue_exclusions')
    .select('hubspot_deal_id, reason, excluded_at')
  const excluded = new Map(
    (exclusionRows ?? []).map((r) => [
      String(r.hubspot_deal_id),
      { reason: String(r.reason), at: String(r.excluded_at) },
    ]),
  )

  const { data: deals, error } = acceptedIds.length === 0 || depots.length === 0
    ? { data: [], error: null }
    : await admin
        .from('deals_registry')
        .select(
          'hubspot_deal_id, deal_name, hubspot_company_id, depot_code, amount, quote_reference, line_items_raw, deal_status, delivery_street, delivery_city, delivery_state, delivery_zip, is_collection',
        )
        .in('hubspot_deal_id', acceptedIds)
        // Both spellings of each depot. The EURO sync writes HubSpot's own
        // value ('EU-France'), the USA sync writes the code ('US-BAL'), and a
        // queue keyed on the code alone showed France nothing, ever.
        .in('depot_code', depotQueryValues(depots))
        .limit(500)

  let rows: QueueRow[] = []
  if (!error && deals && deals.length > 0) {
    // Accepted and then lost is the one onward stage that must not be
    // invoiceable. Everything else stays.
    const eligible = deals.filter((d) => !isNotInvoiceableStage(d.deal_status as string | null))

    const { data: invoices } = eligible.length === 0 ? { data: [] } : await admin
      .from('customer_invoices')
      .select('hubspot_deal_id, status, invoice_number, holding_reference, source_lines_snapshot')
      .in('hubspot_deal_id', eligible.map((d) => String(d.hubspot_deal_id)))
      .neq('status', 'voided')
    const invoiceByDeal = new Map((invoices ?? []).map((i) => [String(i.hubspot_deal_id), i]))

    // Once an invoice enters the pipeline it belongs to a stage queue, not
    // here. Dean, 2026-09-03: "they must move out of accepted quotes and into
    // the tax calculated -> taxjar etc." Before this the same deal sat in both,
    // so a rep working top to bottom saw everything twice and had no way to
    // tell what was still waiting for them.
    //
    // A `draft` invoice deliberately STAYS. It has been opened but not taxed,
    // which is exactly what this queue is for, and it is where the rep left off.
    const stillWaiting = eligible.filter((deal) => {
      if (excluded.has(String(deal.hubspot_deal_id))) return false
      const invoice = invoiceByDeal.get(String(deal.hubspot_deal_id))
      return invoice === undefined || invoice.status === 'draft'
    })

    rows = stillWaiting.map((deal) => {
      const dealId = String(deal.hubspot_deal_id)
      const invoice = invoiceByDeal.get(dealId)
      // The address is checked in the invoicing organisation's own shape (a
      // US address needs a state, a French one must not have one). An
      // organisation with no profile is not held to it, because nothing here
      // can tax its deals yet.
      const addressOk =
        !profile ||
        sanitizeDeliveryAddress(profile.country, {
          street: deal.delivery_street,
          city: deal.delivery_city,
          state: deal.delivery_state,
          zip: deal.delivery_zip,
        }).ok

      let chip: QueueChip
      // A collected deal has no delivery address to be missing: the tax is
      // calculated at the depot it is collected from.
      if (!invoice) chip = addressOk || deal.is_collection === true ? 'new' : 'missing_address'
      else chip = invoice.status as CustomerInvoiceStatus

      const linesChanged = invoice
        ? sourceLinesHash(deal.line_items_raw) !== sourceLinesHash(invoice.source_lines_snapshot)
        : false

      return {
        dealId,
        dealName: String(deal.deal_name ?? dealId),
        companyId: deal.hubspot_company_id ? String(deal.hubspot_company_id) : null,
        depot: depotCode(deal.depot_code) ?? String(deal.depot_code),
        amount: deal.amount === null ? null : Number(deal.amount),
        quoteRef: deal.quote_reference ? String(deal.quote_reference) : null,
        updatedAt: acceptedAt.get(String(deal.hubspot_deal_id)) as string,
        chip,
        linesChanged,
        invoiceNumber: invoice ? String(invoice.invoice_number ?? invoice.holding_reference) : null,
      }
    })
    rows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Accepted Quotes</h1>
        <p className="text-gray-500 text-sm mt-1">
          {orgLabel(org)} quotes marked Quotation Accepted, waiting to be reviewed, taxed and invoiced.
        </p>
      </div>

      {!invoicingLive && (
        <div className="rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <p className="font-semibold">Invoicing for {orgLabel(org)} is not set up in the Hub yet.</p>
          <p className="mt-1">
            The queue is here for reference. Until {orgLabel(org)}&apos;s tax and Xero flow is built, its
            invoices are raised outside the Hub.
          </p>
        </div>
      )}

      {/* Canada, 24 Sep 2026: invoices open and edit here, and the tax step
          is not built yet. Said up front so nobody reviews an invoice
          expecting to finish it in the Hub. */}
      {profile?.xeroNotConnected && (
        <div className="rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <p className="font-semibold">{profile.xeroNotConnected}</p>
          <p className="mt-1">
            You can open, edit and save an invoice here, but it stops before the tax step. Until that step
            is connected, {orgLabel(org)}&apos;s invoices are raised outside the Hub.
          </p>
        </div>
      )}

      {error ? (
        <Card className="p-6 border-red-200 bg-red-50">
          <div className="flex items-center gap-3 text-red-800">
            <AlertCircle className="w-5 h-5" />
            <p className="font-medium">Error loading the accepted-quotes queue</p>
          </div>
        </Card>
      ) : rows.length === 0 ? (
        <Card className="bg-white border-gray-200 p-10 text-center text-gray-500">
          <Inbox className="w-8 h-8 mx-auto mb-3 text-gray-300" />
          <p className="font-medium text-gray-700">No accepted {orgLabel(org)} quotes yet</p>
          <p className="text-sm mt-1">
            Deals appear here a minute or two after a rep marks them Quotation Accepted (they arrive via the
            HubSpot sync).
          </p>
        </Card>
      ) : (
        <>
          {/* Table on md+, stacked cards below */}
          <Card className="bg-white border-gray-200 hidden md:block overflow-x-auto p-0">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-200 text-left text-xs font-semibold uppercase tracking-wide text-gray-700">
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
                    <td className="px-4 py-3 text-gray-600">{depotLabel(row.depot)}</td>
                    <td className="px-4 py-3 text-right tabular-nums text-gray-900">
                      {row.amount === null ? '—' : money.format(row.amount)}
                    </td>
                    <td className="px-4 py-3">
                      <span className="inline-flex items-center gap-1.5">
                        <InvoiceStatusChip chip={row.chip} taxEngine={profile?.taxEngine} />
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
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-1">
                        {canManage && (
                          <ExcludeFromQueueButton dealId={row.dealId} dealName={row.dealName} />
                        )}
                        <OpenInvoiceButton
                          dealId={row.dealId}
                          hasInvoice={row.chip !== 'new' && row.chip !== 'missing_address'}
                          canManage={canManage && invoicingLive}
                        />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>

          <div className="md:hidden space-y-3">
            {rows.map((row) => (
              <Card key={row.dealId} className="bg-white border-gray-200 p-4 space-y-2">
                <div className="flex items-start justify-between gap-2">
                  <p className="font-medium text-gray-900">{row.dealName}</p>
                  <InvoiceStatusChip chip={row.chip} taxEngine={profile?.taxEngine} />
                </div>
                <p className="text-sm text-gray-500">
                  {row.quoteRef ?? 'No quote ref'} · {depotLabel(row.depot)} ·{' '}
                  {row.amount === null ? 'no amount' : money.format(row.amount)}
                </p>
                {row.linesChanged && (
                  <p className="text-xs font-medium text-amber-700">Lines changed on the deal since the draft was built</p>
                )}
                <OpenInvoiceButton
                  dealId={row.dealId}
                  hasInvoice={row.chip !== 'new' && row.chip !== 'missing_address'}
                  canManage={canManage && invoicingLive}
                />
                {canManage && <ExcludeFromQueueButton dealId={row.dealId} dealName={row.dealName} />}
              </Card>
            ))}
          </div>
        </>
      )}

    </div>
  )
}
