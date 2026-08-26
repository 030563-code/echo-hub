'use server'

/**
 * "Send to TaxJar": one /v2/taxes call per ship-from depot group, all-or-
 * nothing persistence. Per-line tax values are canonical (they are what Xero
 * sums); TaxJar's own order totals are reconciled and any gap beyond a cent
 * is surfaced as a warning the reviewer sees before authorizing.
 */

import { z } from 'zod'
import { revalidatePath } from 'next/cache'
import { createAdminClient } from '@/lib/supabase/admin'
import { sanitizeUSAddress } from '@/lib/us-address'
import {
  buildTaxRequests,
  applyTaxResponses,
  type TaxableLine,
  type TaxJarTaxResponse,
  type TaxRequestGroup,
} from '@/lib/customer-invoice/tax-mapping'
import { linesHash } from '@/lib/customer-invoice/hash'
import { roundCents } from '@/lib/quote-math'
import { taxjarCalculateTax, TaxJarError, TaxJarConfigError } from '@/lib/taxjar'
import {
  requireInvoicingManage,
  loadInvoiceWithLines,
  logInvoiceEvent,
} from '@/app/actions/invoicing/shared'

const Input = z.object({ invoiceId: z.string().uuid() })

export type CalculateTaxResult =
  | { success: true; taxTotal: number; total: number; warnings: string[] }
  | { success: false; error: string }

export async function calculateInvoiceTax(input: { invoiceId: string }): Promise<CalculateTaxResult> {
  const gate = await requireInvoicingManage()
  if (!gate.ok) return { success: false, error: gate.error }

  const parsed = Input.safeParse(input)
  if (!parsed.success) return { success: false, error: 'Invalid invoice id' }
  const { invoiceId } = parsed.data

  const loaded = await loadInvoiceWithLines(invoiceId)
  if (!loaded.ok) return { success: false, error: loaded.error }
  const { invoice, lines } = loaded

  if (invoice.status !== 'draft' && invoice.status !== 'tax_calculated') {
    return { success: false, error: `Tax can only be calculated on a draft (this invoice is ${invoice.status}).` }
  }
  if (invoice.currency !== 'USD') {
    return { success: false, error: `US sales tax needs a USD invoice (this one is ${invoice.currency}).` }
  }

  const address = sanitizeUSAddress({
    street: invoice.delivery_street ?? '',
    city: invoice.delivery_city ?? '',
    state: invoice.delivery_state ?? '',
    zip: invoice.delivery_zip ?? '',
  })
  if (!address.ok) return { success: false, error: address.error }

  const taxableLines: TaxableLine[] = lines.map((l) => ({
    line_key: l.line_key,
    quantity: Number(l.quantity),
    unit_price: Number(l.unit_price),
    discount_percentage: Number(l.discount_percentage),
    line_total: Number(l.line_total),
    is_shipping: l.is_shipping,
    ship_from_depot: l.ship_from_depot,
  }))

  const built = buildTaxRequests(taxableLines, address.value, invoice.taxjar_customer_id)
  if (!built.ok) return { success: false, error: built.error }

  const admin = createAdminClient()
  const results: { group: TaxRequestGroup; response: TaxJarTaxResponse }[] = []
  try {
    for (const group of built.groups) {
      const response = await taxjarCalculateTax(group.request)
      results.push({ group, response })
    }
  } catch (err) {
    const message =
      err instanceof TaxJarConfigError
        ? 'The TaxJar API token is not configured on the server.'
        : err instanceof TaxJarError
          ? `TaxJar rejected the calculation: ${err.message}`
          : 'TaxJar could not be reached. Try again in a minute.'
    await admin.from('customer_invoices').update({ error_message: message, updated_at: new Date().toISOString() }).eq('id', invoiceId)
    await logInvoiceEvent(invoiceId, 'tax_failed', gate.auth.user.id, { error: message })
    return { success: false, error: message }
  }

  const applied = applyTaxResponses(taxableLines, results)
  if (!applied.ok) {
    await admin.from('customer_invoices').update({ error_message: applied.error, updated_at: new Date().toISOString() }).eq('id', invoiceId)
    await logInvoiceEvent(invoiceId, 'tax_failed', gate.auth.user.id, { error: applied.error })
    return { success: false, error: applied.error }
  }

  const taxByKey = new Map(applied.lines.map((l) => [l.line_key, l]))
  for (const line of lines) {
    const tax = taxByKey.get(line.line_key)
    await admin
      .from('customer_invoice_lines')
      .update({
        tax_amount: tax?.tax_amount ?? 0,
        taxable_amount: tax?.taxable_amount ?? null,
        combined_tax_rate: tax?.combined_tax_rate ?? null,
        tax_override: false,
      })
      .eq('id', line.id)
  }

  const subtotal = roundCents(taxableLines.filter((l) => !l.is_shipping).reduce((a, l) => a + l.line_total, 0))
  const shippingTotal = roundCents(taxableLines.filter((l) => l.is_shipping).reduce((a, l) => a + l.line_total, 0))
  const taxTotal = applied.taxTotal
  const total = roundCents(subtotal + shippingTotal + taxTotal)

  // Hash computed from the server-stored lines + address the calc actually used.
  const hash = linesHash(
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

  const { data: updated, error: updateError } = await admin
    .from('customer_invoices')
    .update({
      subtotal,
      shipping_total: shippingTotal,
      tax_total: taxTotal,
      total,
      taxjar_request: results.map((r) => ({ depot: r.group.depot, request: r.group.request })),
      taxjar_response: results.map((r) => ({ depot: r.group.depot, response: r.response })),
      tax_calculated_at: new Date().toISOString(),
      lines_hash: hash,
      status: 'tax_calculated',
      error_message: null,
      updated_by_uid: gate.auth.user.id,
      updated_at: new Date().toISOString(),
    })
    .eq('id', invoiceId)
    .in('status', ['draft', 'tax_calculated'])
    .select('id')
  if (updateError || !updated || updated.length === 0) {
    return { success: false, error: 'The invoice changed under you. Refresh and try again.' }
  }

  await logInvoiceEvent(invoiceId, 'tax_calculated', gate.auth.user.id, {
    tax_total: taxTotal,
    warnings: applied.warnings,
  })

  revalidatePath('/invoicing/accepted')
  revalidatePath('/invoicing/drafts')
  revalidatePath(`/invoicing/${invoice.hubspot_deal_id}`)
  return { success: true, taxTotal, total, warnings: applied.warnings }
}
