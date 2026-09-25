import 'server-only'

/**
 * Shared plumbing for the invoicing server actions. Not a 'use server' file —
 * only the action modules are. Every helper here assumes the caller has
 * ALREADY passed requireInvoicingCapability; the tables are service-role-only
 * so all reads/writes go through the admin client.
 */

import { createAdminClient } from '@/lib/supabase/admin'
import { taxjarCreateOrder } from '@/lib/taxjar'
import { INVOICING_QUEUE_SINCE } from '@/lib/customer-invoice/constants'
import { CLOSED_LOST_STAGES, QUOTATION_ACCEPTED_STAGES } from '@/lib/hubspot-constants'
import { buildFilingOrders, type ShipToAddress } from '@/lib/customer-invoice/tax-mapping'
import { sanitizeUSAddress, normalizeUSState } from '@/lib/us-address'
import { getAuthorizedUser, type AuthzOk } from '@/lib/authz'
import { holdsOrganisation, type OrgCode } from '@/lib/organisations'
import type { CustomerInvoiceStatus } from '@/lib/customer-invoice/constants'
import type { InvoicingProfile } from '@/lib/customer-invoice/invoicing-profile'
import type { USDepot, InvoiceDepot } from '@/lib/customer-invoice/constants'

export interface CustomerInvoiceRow {
  id: string
  hubspot_deal_id: string
  /** Internal draft reference (USI...). Gaps are harmless. */
  holding_reference: string
  /** Snapshotted at Send to TaxJar. An issued invoice must not change its
   *  printed terms because someone edited the Xero contact afterwards. */
  payment_terms_label: string | null
  /** The language the PDF's labels and dates print in: 'en', 'fr' or 'es'.
   *  Chosen when the draft is opened and editable until it is numbered, so
   *  every render of an issued invoice reads the same. */
  document_language: string
  pdf_generated_at: string | null
  pdf_sha256: string | null
  xero_attachment_id: string | null
  emailed_to: string | null
  emailed_was_test: boolean
  /** The Xero contact, frozen onto the invoice. A live read at print time would
   *  let an edit in Xero rewrite the address on an invoice already sent. */
  billing_name: string | null
  billing_line1: string | null
  billing_line2: string | null
  billing_city: string | null
  billing_region: string | null
  billing_postal_code: string | null
  billing_country: string | null
  billing_email: string | null
  billing_snapshot_at: string | null
  /** Customer-facing EBUS number, null until the invoice is raised. */
  invoice_number: string | null
  raised_at: string | null
  /** entities.code of the company invoicing: the outer scope of everything
   *  about this row. Set from the deal's depot when the draft is built. */
  organisation_code: string
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
  /** Optional site or depot label at the delivery address, e.g. "Location G52".
   *  Deliberately absent from linesHash: it is not a tax input. */
  delivery_location: string | null
  /** Optional name of whoever requested the delivery. Also not a tax input. */
  delivery_requested_by: string | null
  is_collection: boolean
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
  /** The Xero DRAFT posted to price the tax (France). Separate from
   *  xero_invoice_id on purpose: that column means "authorised, in the ledger",
   *  and three places refuse or short-circuit on it. The authorise leg updates
   *  THIS id in place rather than creating a second Xero invoice. */
  xero_draft_invoice_id: string | null
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
  ship_from_depot: InvoiceDepot
  ship_from_locked: boolean
  tax_amount: number | null
  taxable_amount: number | null
  combined_tax_rate: number | null
  /** Xero tracking, max 2 per line. Read back with parseLineTracking. */
  tracking: unknown
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

/**
 * The invoice and its lines, for an action about to change it.
 *
 * `heldBy` is the caller's organisations. An invoice belonging to one they do
 * not hold answers exactly as a missing one does: whether it exists is not
 * their business either. Every action passes it; the one place it is omitted
 * is a read the page has already scoped.
 */
export async function loadInvoiceWithLines(
  invoiceId: string,
  heldBy?: readonly OrgCode[],
): Promise<
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
  if (heldBy && !holdsOrganisation(heldBy, (invoice as { organisation_code?: string }).organisation_code)) {
    return { ok: false, error: 'Invoice not found.' }
  }

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

/**
 * Which organisation an invoice belongs to, for a caller that only needs that.
 *
 * Same scope rule as loadInvoiceWithLines: an invoice the caller's organisations
 * do not include answers as a missing one. Used by the lookups that talk to Xero
 * on the invoice's behalf, because Xero is per organisation and the wrong one
 * would answer with a different company's items and contacts.
 */
export async function invoiceOrganisation(
  invoiceId: string,
  heldBy: readonly OrgCode[],
): Promise<{ ok: true; org: OrgCode } | { ok: false; error: string }> {
  const admin = createAdminClient()
  const { data, error } = await admin.from('customer_invoices').select('organisation_code').eq('id', invoiceId).maybeSingle()
  if (error) return { ok: false, error: 'Failed to load the invoice.' }
  const org = (data as { organisation_code?: string } | null)?.organisation_code
  if (!data || !holdsOrganisation(heldBy, org)) return { ok: false, error: 'Invoice not found.' }
  return { ok: true, org }
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
  pairs: readonly { sku: string | null; depot: InvoiceDepot }[],
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
    // Every pipeline's Quotation Accepted stage, by ID. The EURO one is
    // 1266942995 and its HubSpot label carries a trailing space, which is why
    // nothing here ever matches on a label.
    .in('new_status', [...QUOTATION_ACCEPTED_STAGES])
    .in('deal_id', [...dealIds])
  for (const row of data ?? []) {
    const id = String(row.deal_id)
    const at = String(row.changed_at)
    const seen = out.get(id)
    if (!seen || at > seen) out.set(id, at)
  }
  return out
}

/**
 * Deals that have EVER entered Quotation Accepted on or after the cutover,
 * mapped to the latest date they did so.
 *
 * Eligibility deliberately does NOT look at the deal's CURRENT stage. Deals
 * move on fast: 64429492377 entered Quotation Accepted at 08:58 on 2026-09-01
 * and left at 09:03, five minutes later. Filtering on the current stage
 * silently dropped every deal that progressed to Closed Won, which is the
 * normal path, and made it permanently un-invoiceable with no error anywhere.
 *
 * A deal that has been accepted stays invoiceable; `isNotInvoiceableStage`
 * removes the one case where that is wrong.
 */
export async function getAcceptedSinceCutover(): Promise<Map<string, string>> {
  const admin = createAdminClient()
  const { data } = await admin
    .from('deal_stage_history')
    .select('deal_id, changed_at')
    .in('new_status', [...QUOTATION_ACCEPTED_STAGES])
    .gte('changed_at', INVOICING_QUEUE_SINCE)
  const out = new Map<string, string>()
  for (const row of data ?? []) {
    const id = String(row.deal_id)
    const at = String(row.changed_at)
    const seen = out.get(id)
    if (!seen || at > seen) out.set(id, at)
  }
  return out
}

/**
 * A deal that was accepted and then LOST must not be invoiceable. Every other
 * onward stage (Closed Won above all) must remain invoiceable, which is the
 * whole point of dating eligibility from history rather than current stage.
 */
export function isNotInvoiceableStage(dealStatus: string | null | undefined): boolean {
  return CLOSED_LOST_STAGES.includes(String(dealStatus ?? ''))
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
/**
 * Freeze the Xero contact onto the invoice.
 *
 * The bill-to block on a printed invoice must not be a live read. Re-reading
 * Xero at print time means an address edited next month silently rewrites the
 * address on an invoice the customer already holds, and nothing records what
 * was actually sent. It also takes the n8n webhook out of the render path, so a
 * preview does not depend on that workflow being up.
 *
 * Best effort by design: a failure here must not block the step that called it.
 */
export async function snapshotBillingContact(
  invoiceId: string,
  contact: {
    name: string | null
    email: string | null
    address: {
      line1: string | null
      line2: string | null
      city: string | null
      region: string | null
      postal_code: string | null
      country: string | null
    } | null
  },
): Promise<void> {
  try {
    const admin = createAdminClient()
    await admin
      .from('customer_invoices')
      .update({
        billing_name: contact.name,
        billing_email: contact.email,
        billing_line1: contact.address?.line1 ?? null,
        billing_line2: contact.address?.line2 ?? null,
        billing_city: contact.address?.city ?? null,
        // Xero holds whatever was typed. Canonicalised on the way in so the
        // stored bill-to matches the ship-to beside it on the invoice.
        billing_region: normalizeUSState(contact.address?.region) || null,
        billing_postal_code: contact.address?.postal_code ?? null,
        billing_country: contact.address?.country ?? null,
        billing_snapshot_at: new Date().toISOString(),
      })
      .eq('id', invoiceId)
  } catch (error) {
    console.error('snapshotBillingContact failed', error)
  }
}

/**
 * Keep the Xero account number an invoice was numbered under on its company,
 * so the company's next invoice opens with it already filled in.
 *
 * The USA and Canada get a code generated when a deal is accepted
 * (ensure_company_xero_codes). France has no generator: the code has to be the
 * contact's own number in Echo Barrier SAS's Xero, and until now a number typed
 * on one invoice was forgotten with that invoice.
 *
 * Only ever fills an EMPTY code. A code already on the company is the
 * company's, and one invoice billed elsewhere is no reason to change where
 * every later invoice goes. A company with no registry row is left alone
 * rather than inserted. Best effort: the invoice is already numbered, and a
 * failure here only means the next invoice needs the number typed again.
 */
export async function rememberXeroAccountNumber(
  column: InvoicingProfile['accountCodeColumn'],
  hubspotCompanyId: string | null,
  accountNumber: string | null,
): Promise<boolean> {
  const companyId = String(hubspotCompanyId ?? '').replace(/\D/g, '')
  const code = String(accountNumber ?? '').trim()
  if (companyId === '' || code === '') return false
  try {
    const admin = createAdminClient()
    const { data, error } = await admin
      .from('account_registry')
      .update({ [column]: code, updated_at: new Date().toISOString() })
      .eq('hubspot_company_id', Number(companyId))
      // Empty means NULL or ''. The registry holds thousands of empty strings.
      .or(`${column}.is.null,${column}.eq.`)
      .select('hubspot_company_id')
    if (error) {
      console.error('rememberXeroAccountNumber failed', error.message)
      return false
    }
    return (data ?? []).length > 0
  } catch (error) {
    console.error('rememberXeroAccountNumber threw', error instanceof Error ? error.message : 'unknown')
    return false
  }
}

export async function recordTaxJarOrders(
  invoice: CustomerInvoiceRow,
  lines: CustomerInvoiceLineRow[],
  documentNumber: string,
): Promise<{ ok: true; transactionIds: string[] } | { ok: false; error: string }> {
  try {
    // A collected order is taxed at the depot, so it needs no delivery address
    // and must not be filed against one. Only a delivered order sanitizes the
    // customer address, and it uses exactly the sanitizer the calculation used
    // so the filed transaction and the calculated tax describe the same place.
    let shipTo: ShipToAddress | null = null
    if (!invoice.is_collection) {
      const address = sanitizeUSAddress({
        street: invoice.delivery_street ?? '',
        city: invoice.delivery_city ?? '',
        state: invoice.delivery_state ?? '',
        zip: invoice.delivery_zip ?? '',
      })
      if (!address.ok) return { ok: false, error: address.error }
      shipTo = address.value
    }

    const built = buildFilingOrders(
      lines.map((l) => ({
        line_key: l.line_key,
        quantity: Number(l.quantity),
        unit_price: Number(l.unit_price),
        discount_percentage: Number(l.discount_percentage),
        line_total: Number(l.line_total),
        is_shipping: l.is_shipping,
        ship_from_depot: l.ship_from_depot as USDepot,
        sku: l.sku,
        name: l.name,
        description: l.description,
        tax_amount: l.tax_amount === null ? null : Number(l.tax_amount),
      })),
      shipTo,
      invoice.taxjar_customer_id,
      invoice.is_collection,
      {
        transactionDate: invoice.invoice_date ?? new Date().toISOString().slice(0, 10),
        xeroInvoiceNumber: documentNumber,
      },
    )
    if (!built.ok) return { ok: false, error: built.error }

    const transactionIds: string[] = []
    for (const order of built.orders) {
      await taxjarCreateOrder(order)
      transactionIds.push(order.transaction_id)
    }
    return { ok: true, transactionIds }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'unknown error' }
  }
}
