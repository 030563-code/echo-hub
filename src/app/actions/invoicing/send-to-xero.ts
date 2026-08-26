'use server'

/**
 * "Send to Xero": compare-and-set to `authorizing`, hand the credentialed work
 * to n8n (Xero lives only there), persist the returned ids. n8n is idempotent
 * (it checks customer_invoices.xero_invoice_id before creating and writes the
 * ids back itself), so a retry after a timeout can never double-create.
 * After authorization the order is recorded into TaxJar for filing,
 * best-effort (stubbed in sandbox).
 */

import { z } from 'zod'
import { revalidatePath } from 'next/cache'
import { createAdminClient } from '@/lib/supabase/admin'
import { sanitizeUSAddress } from '@/lib/us-address'
import { linesHash } from '@/lib/customer-invoice/hash'
import {
  requireInvoicingManage,
  loadInvoiceWithLines,
  logInvoiceEvent,
  recordTaxJarOrders,
} from '@/app/actions/invoicing/shared'

const Input = z.object({
  invoiceId: z.string().uuid(),
  emailToCustomer: z.boolean(),
})

export type SendToXeroResult =
  | { success: true; xeroInvoiceNumber: string; emailed: boolean; warnings: string[] }
  | { success: false; error: string }

interface N8nAuthorizeResponse {
  xero_invoice_id?: string
  xero_invoice_number?: string
  emailed?: boolean
  error?: string
}

export async function sendInvoiceToXero(input: { invoiceId: string; emailToCustomer: boolean }): Promise<SendToXeroResult> {
  const gate = await requireInvoicingManage()
  if (!gate.ok) return { success: false, error: gate.error }

  const parsed = Input.safeParse(input)
  if (!parsed.success) return { success: false, error: 'Invalid input' }
  const { invoiceId, emailToCustomer } = parsed.data

  const webhookUrl = process.env.N8N_CUSTOMER_INVOICE_WEBHOOK_URL
  if (!webhookUrl) return { success: false, error: 'The invoice webhook is not configured on the server.' }

  const loaded = await loadInvoiceWithLines(invoiceId)
  if (!loaded.ok) return { success: false, error: loaded.error }
  const { invoice, lines } = loaded

  if (invoice.status !== 'tax_calculated') {
    return { success: false, error: `Only a tax-calculated invoice can be sent (this one is ${invoice.status}).` }
  }
  if (invoice.xero_invoice_id) {
    return { success: false, error: `This invoice is already in Xero as ${invoice.xero_invoice_number ?? invoice.xero_invoice_id}.` }
  }
  if (!invoice.taxjar_customer_id) {
    return {
      success: false,
      error: 'This company has no Xero account code yet, so the Xero contact cannot be resolved. Fix the account code first.',
    }
  }

  const address = sanitizeUSAddress({
    street: invoice.delivery_street ?? '',
    city: invoice.delivery_city ?? '',
    state: invoice.delivery_state ?? '',
    zip: invoice.delivery_zip ?? '',
  })
  if (!address.ok) return { success: false, error: address.error }

  // Belt-and-braces staleness check against a stale browser tab.
  const currentHash = linesHash(
    lines.map((l) => ({
      line_key: l.line_key,
      sku: l.sku,
      quantity: Number(l.quantity),
      unit_price: Number(l.unit_price),
      discount_percentage: Number(l.discount_percentage),
      is_shipping: l.is_shipping,
      ship_from_depot: l.ship_from_depot,
    })),
    {
      delivery_street: invoice.delivery_street,
      delivery_city: invoice.delivery_city,
      delivery_state: invoice.delivery_state,
      delivery_zip: invoice.delivery_zip,
      taxjar_customer_id: invoice.taxjar_customer_id,
    },
  )
  if (currentHash !== invoice.lines_hash) {
    return { success: false, error: 'The invoice changed since tax was calculated. Recalculate tax first.' }
  }

  const admin = createAdminClient()
  const { data: cas, error: casError } = await admin
    .from('customer_invoices')
    .update({ status: 'authorizing', updated_by_uid: gate.auth.user.id, updated_at: new Date().toISOString() })
    .eq('id', invoiceId)
    .eq('status', 'tax_calculated')
    .select('id')
  if (casError || !cas || cas.length === 0) {
    return { success: false, error: 'This invoice is already being sent.' }
  }
  await logInvoiceEvent(invoiceId, 'authorize_requested', gate.auth.user.id, { email_to_customer: emailToCustomer })

  const payload = {
    idempotency_key: invoice.idempotency_key,
    invoice_id: invoice.id,
    invoice_number: invoice.invoice_number,
    hubspot_deal_id: invoice.hubspot_deal_id,
    quote_reference: null as string | null,
    reference: invoice.customer_po_number ?? '',
    contact: {
      xero_account_number: invoice.taxjar_customer_id,
      hubspot_company_id: invoice.hubspot_company_id,
      company_name: invoice.company_name,
    },
    currency: invoice.currency,
    date: invoice.invoice_date,
    due_date: invoice.due_date,
    line_amount_types: 'Exclusive',
    lines: lines
      .filter((l) => !l.is_shipping)
      .map((l) => ({
        item_code: l.xero_item_code,
        account_code: l.account_code,
        description: l.description || l.name,
        quantity: Number(l.quantity),
        unit_amount: Number(l.unit_price),
        discount_rate: Number(l.discount_percentage),
        tax_amount: Number(l.tax_amount ?? 0),
      })),
    shipping_lines: lines
      .filter((l) => l.is_shipping)
      .map((l) => ({
        item_code: l.xero_item_code,
        account_code: l.account_code,
        description: l.description || l.name,
        quantity: Number(l.quantity),
        unit_amount: Number(l.unit_price),
        tax_amount: Number(l.tax_amount ?? 0),
      })),
    totals: {
      subtotal: Number(invoice.subtotal ?? 0),
      shipping_total: Number(invoice.shipping_total ?? 0),
      tax_total: Number(invoice.tax_total ?? 0),
      total: Number(invoice.total ?? 0),
    },
    email_to_customer: emailToCustomer,
  }

  // The deal's quote reference lives on deals_registry; carried for the Xero
  // history note (never customer-visible).
  const { data: deal } = await admin
    .from('deals_registry')
    .select('quote_reference')
    .eq('hubspot_deal_id', invoice.hubspot_deal_id)
    .maybeSingle()
  payload.quote_reference = deal?.quote_reference ?? null

  let response: N8nAuthorizeResponse
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 30_000)
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(process.env.N8N_CUSTOMER_INVOICE_WEBHOOK_SECRET
          ? { 'x-hub-secret': process.env.N8N_CUSTOMER_INVOICE_WEBHOOK_SECRET }
          : {}),
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
      cache: 'no-store',
    })
    clearTimeout(timer)
    if (!res.ok) throw new Error(`webhook HTTP ${res.status}`)
    response = (await res.json()) as N8nAuthorizeResponse
    if (!response.xero_invoice_id || !response.xero_invoice_number) {
      throw new Error(response.error || 'webhook returned no invoice ids')
    }
  } catch (err) {
    const message =
      err instanceof Error && err.name === 'AbortError'
        ? 'Xero did not respond within 30 seconds. The invoice may still have been created; retry is safe.'
        : `Sending to Xero failed: ${err instanceof Error ? err.message : 'unknown error'}`
    await admin
      .from('customer_invoices')
      .update({ status: 'tax_calculated', error_message: message, updated_at: new Date().toISOString() })
      .eq('id', invoiceId)
      .eq('status', 'authorizing')
    await logInvoiceEvent(invoiceId, 'authorize_failed', gate.auth.user.id, { error: message })
    return { success: false, error: message }
  }

  const emailed = Boolean(response.emailed)
  const now = new Date().toISOString()
  await admin
    .from('customer_invoices')
    .update({
      status: emailed ? 'sent' : 'authorized',
      xero_invoice_id: response.xero_invoice_id,
      xero_invoice_number: response.xero_invoice_number,
      authorized_at: now,
      ...(emailed ? { emailed_at: now } : {}),
      error_message: null,
      updated_by_uid: gate.auth.user.id,
      updated_at: now,
    })
    .eq('id', invoiceId)
    .eq('status', 'authorizing')
  await logInvoiceEvent(invoiceId, 'authorized', gate.auth.user.id, {
    xero_invoice_number: response.xero_invoice_number,
    emailed,
  })

  const warnings: string[] = []
  const recorded = await recordTaxJarOrders(invoice, lines, response.xero_invoice_number)
  if (recorded.ok) {
    await admin
      .from('customer_invoices')
      .update({
        taxjar_transaction_id: recorded.transactionIds.join(','),
        taxjar_transaction_recorded_at: new Date().toISOString(),
        status: 'completed',
        updated_at: new Date().toISOString(),
      })
      .eq('id', invoiceId)
      .in('status', ['authorized', 'sent'])
    await logInvoiceEvent(invoiceId, 'taxjar_recorded', gate.auth.user.id, { transaction_ids: recorded.transactionIds })
  } else {
    warnings.push(`Invoice created, but recording it in TaxJar for filing failed: ${recorded.error}. Use Retry in the editor.`)
    await logInvoiceEvent(invoiceId, 'taxjar_record_failed', gate.auth.user.id, { error: recorded.error })
  }

  revalidatePath('/invoicing/accepted')
  revalidatePath('/invoicing/drafts')
  revalidatePath(`/invoicing/${invoice.hubspot_deal_id}`)
  return { success: true, xeroInvoiceNumber: response.xero_invoice_number, emailed, warnings }
}

