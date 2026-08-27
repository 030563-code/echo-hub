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
import { DEPOT_FROM_ADDRESSES, US_DEPOTS, US_ACCEPTED_DEAL_STATUS, INVOICING_QUEUE_SINCE } from '@/lib/customer-invoice/constants'
import { sanitizeUSAddress } from '@/lib/us-address'
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
 * When each deal was actually moved to Quotation Accepted, from
 * deal_stage_history (written by the capture_deal_stage_change trigger).
 *
 * deals_registry.updated_at is NOT this: it does not move when n8n syncs an
 * acceptance, and is routinely days to months older than the acceptance (one
 * deal accepted 2026-08-25 carries updated_at of 2026-06-02), so filtering on
 * it would hide almost every real deal from the queue.
 *
 * A deal with no history row cannot be dated. The trigger has been recording
 * since 2026-08-19, before the cutover, so an undated deal was necessarily
 * accepted before the cutover and is correctly treated as ineligible.
 */
export async function getAcceptedAt(dealIds: readonly string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  if (dealIds.length === 0) return out
  const admin = createAdminClient()
  const { data } = await admin
    .from('deal_stage_history')
    .select('deal_id, changed_at')
    .eq('new_status', US_ACCEPTED_DEAL_STATUS)
    .in('deal_id', [...dealIds])
  for (const row of data ?? []) {
    const id = String(row.deal_id)
    const at = String(row.changed_at)
    const seen = out.get(id)
    if (!seen || at > seen) out.set(id, at)
  }
  return out
}

/** True when the deal was accepted on or after the Hub invoicing cutover. */
export function isAcceptedSinceCutover(acceptedAt: string | undefined): boolean {
  return Boolean(acceptedAt) && (acceptedAt as string) >= INVOICING_QUEUE_SINCE
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
    // Same sanitization the calculation used, so the filed transaction and the
    // calculated tax describe the same destination.
    const address = sanitizeUSAddress({
      street: invoice.delivery_street ?? '',
      city: invoice.delivery_city ?? '',
      state: invoice.delivery_state ?? '',
      zip: invoice.delivery_zip ?? '',
    })
    if (!address.ok) return { ok: false, error: address.error }
    const shipTo = address.value

    // Freight is attributed exactly as buildTaxRequests attributed it for the
    // calculation: a depot carrying only freight has that freight folded into
    // the first depot that carries goods. Filing it any other way would put
    // the freight tax in a jurisdiction the calculation never used.
    const depotsWithGoods = US_DEPOTS.filter((d) => lines.some((l) => l.ship_from_depot === d && !l.is_shipping))
    if (depotsWithGoods.length === 0) return { ok: false, error: 'invoice has no product lines' }
    const host = depotsWithGoods[0]
    const shippingFor = (depot: USDepot) =>
      lines.filter(
        (l) =>
          l.is_shipping &&
          (l.ship_from_depot === depot ||
            (depot === host && !depotsWithGoods.includes(l.ship_from_depot))),
      )

    const transactionIds: string[] = []
    for (const depot of depotsWithGoods) {
      const from = DEPOT_FROM_ADDRESSES[depot]
      if (!from) return { ok: false, error: `${depot} dispatch address not configured` }

      const taxable = lines.filter((l) => l.ship_from_depot === depot && !l.is_shipping)
      const shippingLines = shippingFor(depot)
      const shipping = roundCents(shippingLines.reduce((a, l) => a + Number(l.line_total), 0))
      const salesTax = roundCents(
        [...taxable, ...shippingLines].reduce((a, l) => a + Number(l.tax_amount ?? 0), 0),
      )

      // TaxJar sums each line as quantity x unit_price - discount and rejects
      // the order unless `amount` equals that sum plus shipping, EXCLUDING
      // tax. Deriving the discount from the stored line_total makes TaxJar's
      // arithmetic land on exactly our line totals, so the filed amount and
      // the invoiced amount cannot drift apart by a rounding cent.
      const orderLines = taxable.map((l) => {
        const quantity = Number(l.quantity)
        const unitPrice = Number(l.unit_price)
        const gross = roundCents(quantity * unitPrice)
        const discount = roundCents(gross - Number(l.line_total))
        return {
          id: l.line_key,
          quantity,
          product_identifier: l.sku ?? undefined,
          description: (l.description || l.name).slice(0, 255),
          unit_price: unitPrice,
          ...(discount > 0 ? { discount } : {}),
          sales_tax: Number(l.tax_amount ?? 0),
        }
      })
      const amount = roundCents(taxable.reduce((a, l) => a + Number(l.line_total), 0) + shipping)
      const transactionId = depotsWithGoods.length > 1 ? `${xeroInvoiceNumber}-${depot}` : xeroInvoiceNumber

      await taxjarCreateOrder({
        transaction_id: transactionId,
        transaction_date: invoice.invoice_date ?? new Date().toISOString().slice(0, 10),
        from_country: from.country,
        from_state: from.state,
        from_zip: from.zip,
        from_city: from.city,
        from_street: from.street,
        to_country: 'US',
        to_state: shipTo.state,
        to_zip: shipTo.zip,
        to_city: shipTo.city,
        to_street: shipTo.street,
        amount,
        shipping,
        sales_tax: salesTax,
        ...(invoice.taxjar_customer_id ? { customer_id: invoice.taxjar_customer_id } : {}),
        line_items: orderLines,
      })
      transactionIds.push(transactionId)
    }
    return { ok: true, transactionIds }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'unknown error' }
  }
}
