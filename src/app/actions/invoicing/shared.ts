import 'server-only'

/**
 * Shared plumbing for the invoicing server actions. Not a 'use server' file —
 * only the action modules are. Every helper here assumes the caller has
 * ALREADY passed requireInvoicingCapability; the tables are service-role-only
 * so all reads/writes go through the admin client.
 */

import { createAdminClient } from '@/lib/supabase/admin'
import { roundCents } from '@/lib/quote-math'
import { taxjarCreateOrder } from '@/lib/taxjar'
import { DEPOT_FROM_ADDRESSES, US_DEPOTS } from '@/lib/customer-invoice/constants'
import { getAuthorizedUser, type AuthzOk } from '@/lib/authz'
import type { CustomerInvoiceStatus } from '@/lib/customer-invoice/constants'
import type { USDepot } from '@/lib/customer-invoice/constants'

export interface CustomerInvoiceRow {
  id: string
  hubspot_deal_id: string
  invoice_number: string
  status: CustomerInvoiceStatus
  currency: string
  invoice_date: string | null
  due_date: string | null
  hubspot_company_id: string | null
  company_name: string | null
  taxjar_customer_id: string | null
  customer_po_number: string | null
  delivery_street: string | null
  delivery_city: string | null
  delivery_state: string | null
  delivery_zip: string | null
  delivery_country: string
  subtotal: number | null
  shipping_total: number | null
  tax_total: number | null
  total: number | null
  taxjar_request: unknown
  taxjar_response: unknown
  tax_calculated_at: string | null
  lines_hash: string | null
  source_lines_snapshot: unknown
  idempotency_key: string
  xero_invoice_id: string | null
  xero_invoice_number: string | null
  authorized_at: string | null
  emailed_at: string | null
  taxjar_transaction_id: string | null
  taxjar_transaction_recorded_at: string | null
  error_message: string | null
  created_at: string
  updated_at: string
}

export interface CustomerInvoiceLineRow {
  id: string
  invoice_id: string
  line_key: string
  sort_order: number
  origin: 'hubspot' | 'kit_split' | 'manual'
  parent_line_key: string | null
  hs_line_item_id: string | null
  hs_product_id: string | null
  sku: string | null
  xero_item_code: string | null
  account_code: string | null
  name: string
  description: string | null
  quantity: number
  unit_price: number
  discount_percentage: number
  line_total: number
  is_shipping: boolean
  ship_from_depot: USDepot
  ship_from_locked: boolean
  tax_amount: number | null
  taxable_amount: number | null
  combined_tax_rate: number | null
  tax_override: boolean
}

export type InvoicingAuth = { ok: true; auth: AuthzOk } | { ok: false; error: string }

/** Capability gate for every invoicing action: invoicing.manage required
 *  (invoicing.view is read-only and only used by the pages). */
export async function requireInvoicingManage(): Promise<InvoicingAuth> {
  const auth = await getAuthorizedUser()
  if (!auth.ok) return { ok: false, error: auth.error }
  if (!auth.capabilities.has('invoicing.manage')) {
    return { ok: false, error: 'Forbidden: needs invoicing.manage' }
  }
  return { ok: true, auth }
}

export async function loadInvoiceWithLines(invoiceId: string): Promise<
  { ok: true; invoice: CustomerInvoiceRow; lines: CustomerInvoiceLineRow[] } | { ok: false; error: string }
> {
  const admin = createAdminClient()
  const { data: invoice, error } = await admin
    .from('customer_invoices')
    .select('*')
    .eq('id', invoiceId)
    .maybeSingle()
  if (error) return { ok: false, error: 'Failed to load the invoice.' }
  if (!invoice) return { ok: false, error: 'Invoice not found.' }

  const { data: lines, error: linesError } = await admin
    .from('customer_invoice_lines')
    .select('*')
    .eq('invoice_id', invoiceId)
    .order('sort_order', { ascending: true })
  if (linesError) return { ok: false, error: 'Failed to load the invoice lines.' }

  return {
    ok: true,
    invoice: invoice as CustomerInvoiceRow,
    lines: (lines ?? []) as CustomerInvoiceLineRow[],
  }
}

/** Append-only audit event; best-effort by design (an event write must never
 *  fail the action that caused it). */
export async function logInvoiceEvent(
  invoiceId: string,
  event: string,
  actorUid: string | null,
  payload?: Record<string, unknown>,
): Promise<void> {
  try {
    const admin = createAdminClient()
    await admin.from('customer_invoice_events').insert({
      invoice_id: invoiceId,
      event,
      actor_uid: actorUid,
      payload: payload ?? null,
    })
  } catch {
    // swallow: audit trail is advisory
  }
}

/** Re-resolve Xero item codes for a set of lines against product_depot_mapping
 *  for each line's OWN ship-from depot (the registry enrichment assumed the
 *  deal depot). Returns a map keyed `sku|depot`. */
export async function lookupXeroItemCodes(
  pairs: readonly { sku: string | null; depot: USDepot }[],
): Promise<Map<string, string>> {
  const skus = [...new Set(pairs.map((p) => p.sku).filter((s): s is string => Boolean(s)))]
  const out = new Map<string, string>()
  if (skus.length === 0) return out

  const admin = createAdminClient()
  const { data } = await admin
    .from('product_depot_mapping')
    .select('hubspot_sku_code, depot_code, xero_item_code, is_active')
    .in('hubspot_sku_code', skus)
    .eq('is_active', true)
  for (const row of data ?? []) {
    if (row.xero_item_code) out.set(`${row.hubspot_sku_code}|${row.depot_code}`, row.xero_item_code)
  }
  return out
}

/**
 * Record the authorized invoice into TaxJar for filing, one order per
 * ship-from depot (TaxJar transactions take a single from-address). Stubbed
 * in sandbox. transaction_id = the Xero invoice number (suffixed per depot
 * when the invoice ships from both).
 */
export async function recordTaxJarOrders(
  invoice: CustomerInvoiceRow,
  lines: CustomerInvoiceLineRow[],
  xeroInvoiceNumber: string,
): Promise<{ ok: true; transactionIds: string[] } | { ok: false; error: string }> {
  try {
    const depots = US_DEPOTS.filter((d) => lines.some((l) => l.ship_from_depot === d))
    const transactionIds: string[] = []
    for (const depot of depots) {
      const from = DEPOT_FROM_ADDRESSES[depot]
      if (!from) return { ok: false, error: `${depot} dispatch address not configured` }
      const depotLines = lines.filter((l) => l.ship_from_depot === depot)
      const taxable = depotLines.filter((l) => !l.is_shipping)
      const shipping = roundCents(depotLines.filter((l) => l.is_shipping).reduce((a, l) => a + Number(l.line_total), 0))
      const amount = roundCents(taxable.reduce((a, l) => a + Number(l.line_total), 0) + shipping)
      const salesTax = roundCents(depotLines.reduce((a, l) => a + Number(l.tax_amount ?? 0), 0))
      const transactionId = depots.length > 1 ? `${xeroInvoiceNumber}-${depot}` : xeroInvoiceNumber

      await taxjarCreateOrder({
        transaction_id: transactionId,
        transaction_date: invoice.invoice_date ?? new Date().toISOString().slice(0, 10),
        from_country: from.country,
        from_state: from.state,
        from_zip: from.zip,
        from_city: from.city,
        from_street: from.street,
        to_country: 'US',
        to_state: invoice.delivery_state ?? '',
        to_zip: invoice.delivery_zip ?? '',
        to_city: invoice.delivery_city ?? undefined,
        to_street: invoice.delivery_street ?? undefined,
        amount,
        shipping,
        sales_tax: salesTax,
        ...(invoice.taxjar_customer_id ? { customer_id: invoice.taxjar_customer_id } : {}),
        line_items: taxable.map((l) => ({
          id: l.line_key,
          quantity: Number(l.quantity),
          product_identifier: l.sku ?? undefined,
          description: (l.description || l.name).slice(0, 255),
          unit_price: Number(l.unit_price),
          ...(Number(l.discount_percentage) > 0
            ? { discount: roundCents(Number(l.quantity) * Number(l.unit_price) * (Number(l.discount_percentage) / 100)) }
            : {}),
          sales_tax: Number(l.tax_amount ?? 0),
        })),
      })
      transactionIds.push(transactionId)
    }
    return { ok: true, transactionIds }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'unknown error' }
  }
}
