'use server'

/**
 * Find-or-create the draft customer invoice for an accepted US deal. Building
 * snapshots the deal's line_items_raw (fitting-kit split applied), delivery
 * address and Xero account code; the invoice is then edited independently of
 * the deal, with drift surfaced via the source snapshot hash.
 */

import { z } from 'zod'
import { revalidatePath } from 'next/cache'
import { createAdminClient } from '@/lib/supabase/admin'
import { buildDraftLines, type RawDealLine } from '@/lib/customer-invoice/build-draft'
import { isUSDepot } from '@/lib/customer-invoice/constants'
import { linesHash } from '@/lib/customer-invoice/hash'
import { requireInvoicingManage, lookupXeroItemCodes } from '@/app/actions/invoicing/shared'

const Input = z.object({ dealId: z.string().regex(/^\d+$/) })

export type OpenInvoiceResult =
  | { success: true; invoiceId: string; created: boolean }
  | { success: false; error: string }

export async function openInvoiceForDeal(input: { dealId: string }): Promise<OpenInvoiceResult> {
  const gate = await requireInvoicingManage()
  if (!gate.ok) return { success: false, error: gate.error }

  const parsed = Input.safeParse(input)
  if (!parsed.success) return { success: false, error: 'Invalid deal id' }
  const { dealId } = parsed.data

  const admin = createAdminClient()

  const { data: existing } = await admin
    .from('customer_invoices')
    .select('id')
    .eq('hubspot_deal_id', dealId)
    .neq('status', 'voided')
    .maybeSingle()
  if (existing) return { success: true, invoiceId: existing.id, created: false }

  const { data: deal, error: dealError } = await admin
    .from('deals_registry')
    .select(
      'hubspot_deal_id, hubspot_company_id, deal_name, depot_code, currency, line_items_raw, quote_reference, delivery_street, delivery_city, delivery_state, delivery_zip',
    )
    .eq('hubspot_deal_id', dealId)
    .maybeSingle()
  if (dealError) return { success: false, error: 'Failed to load the deal from the registry.' }
  if (!deal) return { success: false, error: 'This deal has no registry row yet. It appears a minute or two after acceptance.' }

  const depot = String(deal.depot_code ?? '').trim().toUpperCase()
  if (!isUSDepot(depot)) {
    return { success: false, error: `US invoicing only handles US-BAL and US-SBD deals (this deal's depot is ${depot || 'not set'}).` }
  }
  const currency = String(deal.currency ?? 'USD').trim().toUpperCase() || 'USD'
  if (currency !== 'USD') {
    return { success: false, error: `Expected a USD deal but the registry says ${currency}.` }
  }

  // Xero account number doubles as the TaxJar customer id.
  let companyName: string | null = null
  let xeroAccountCode: string | null = null
  const companyIdClean = String(deal.hubspot_company_id ?? '').replace(/\D/g, '')
  if (companyIdClean) {
    const { data: account } = await admin
      .from('account_registry')
      .select('hubspot_company_name, usa_xero_account_code')
      .eq('hubspot_company_id', Number(companyIdClean))
      .maybeSingle()
    companyName = account?.hubspot_company_name ?? null
    xeroAccountCode = account?.usa_xero_account_code ?? null
  }

  const rawLines = (Array.isArray(deal.line_items_raw) ? deal.line_items_raw : []) as RawDealLine[]
  const lines = buildDraftLines(rawLines, depot)

  // Resolve Xero item codes for each line's own ship-from depot.
  const codes = await lookupXeroItemCodes(lines.map((l) => ({ sku: l.sku, depot: l.ship_from_depot })))
  for (const line of lines) {
    if (line.sku) {
      const mapped = codes.get(`${line.sku}|${line.ship_from_depot}`)
      if (mapped) line.xero_item_code = mapped
    }
  }

  const header = {
    hubspot_deal_id: dealId,
    currency: 'USD',
    hubspot_company_id: companyIdClean || null,
    company_name: companyName ?? deal.deal_name ?? null,
    taxjar_customer_id: xeroAccountCode,
    delivery_street: deal.delivery_street ?? null,
    delivery_city: deal.delivery_city ?? null,
    delivery_state: deal.delivery_state ?? null,
    delivery_zip: deal.delivery_zip ?? null,
    delivery_country: 'US',
    subtotal: lines.filter((l) => !l.is_shipping).reduce((acc, l) => acc + l.line_total, 0),
    shipping_total: lines.filter((l) => l.is_shipping).reduce((acc, l) => acc + l.line_total, 0),
    source_lines_snapshot: rawLines,
    lines_hash: linesHash(lines, {
      delivery_street: deal.delivery_street ?? null,
      delivery_city: deal.delivery_city ?? null,
      delivery_state: deal.delivery_state ?? null,
      delivery_zip: deal.delivery_zip ?? null,
      taxjar_customer_id: xeroAccountCode,
    }),
    created_by_uid: gate.auth.user.id,
  }

  const { data: created, error: createError } = await admin.rpc('create_customer_invoice', {
    p_header: header,
    p_lines: lines,
  })

  if (createError) {
    // Unique violation on the active-per-deal index = a concurrent open; the
    // invoice exists now, so hand it back instead of failing.
    if (createError.code === '23505' || /duplicate key/i.test(createError.message ?? '')) {
      const { data: raced } = await admin
        .from('customer_invoices')
        .select('id')
        .eq('hubspot_deal_id', dealId)
        .neq('status', 'voided')
        .maybeSingle()
      if (raced) return { success: true, invoiceId: raced.id, created: false }
    }
    return { success: false, error: 'Could not create the draft invoice.' }
  }

  revalidatePath('/invoicing/accepted')
  revalidatePath('/invoicing/drafts')
  return { success: true, invoiceId: (created as { id: string }).id, created: true }
}
