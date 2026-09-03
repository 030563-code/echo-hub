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
  collectionWarnings,
  type TaxableLine,
  type TaxJarTaxResponse,
  type TaxRequestGroup,
  type ShipToAddress,
} from '@/lib/customer-invoice/tax-mapping'
import { linesHash } from '@/lib/customer-invoice/hash'
import { roundCents } from '@/lib/quote-math'
import { taxjarCalculateTax, taxjarNexusRegions, TaxJarError, TaxJarConfigError } from '@/lib/taxjar'
import { US_REGISTERED_STATES } from '@/lib/customer-invoice/constants'
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

  // A collected order is taxed at the depot it is collected from, so it needs
  // no delivery address. Only a delivered order requires one.
  let shipTo: ShipToAddress | null = null
  if (!invoice.is_collection) {
    const address = sanitizeUSAddress({
      street: invoice.delivery_street ?? '',
      city: invoice.delivery_city ?? '',
      state: invoice.delivery_state ?? '',
      zip: invoice.delivery_zip ?? '',
    })
    if (!address.ok) return { success: false, error: address.error }
    shipTo = address.value
  }

  const taxableLines: TaxableLine[] = lines.map((l) => ({
    line_key: l.line_key,
    quantity: Number(l.quantity),
    unit_price: Number(l.unit_price),
    discount_percentage: Number(l.discount_percentage),
    line_total: Number(l.line_total),
    is_shipping: l.is_shipping,
    ship_from_depot: l.ship_from_depot,
  }))

  const built = buildTaxRequests(taxableLines, shipTo, invoice.taxjar_customer_id, invoice.is_collection)
  if (!built.ok) return { success: false, error: built.error }

  // Fail fast, before spending any calculation calls: refuse a destination in a
  // state Echo Barrier is registered in but that TaxJar is not switched on for.
  // Checked against the LIVE nexus list rather than the has_nexus flag on the
  // calculation, because that flag does not reliably reflect nexus settings
  // (the sandbox returns true for Maryland while /v2/nexus/regions excludes
  // it). Reading it live also means switching Maryland on in TaxJar clears
  // this by itself, with no deploy.
  const admin = createAdminClient()
  try {
    const liveNexus = new Set(await taxjarNexusRegions())
    const blocked = [
      ...new Set(
        built.groups
          .map((g) => g.request.to_state)
          .filter((state) => US_REGISTERED_STATES.includes(state) && !liveNexus.has(state)),
      ),
    ]
    if (blocked.length > 0) {
      const states = blocked.join(' and ')
      const message = `Echo Barrier is registered for sales tax in ${states}, but TaxJar is not collecting there, so this invoice would charge zero and under-collect. Switch ${states} on in the TaxJar account, then recalculate.`
      await logInvoiceEvent(invoiceId, 'tax_failed', gate.auth.user.id, { error: message, blocked })
      return { success: false, error: message }
    }
  } catch (err) {
    // A nexus read failure must not silently skip the guard.
    const message =
      err instanceof TaxJarConfigError
        ? 'The TaxJar API token is not configured on the server.'
        : 'TaxJar could not be reached to check which states it collects for. Try again in a minute.'
    return { success: false, error: message }
  }

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
    await admin.from('customer_invoices').update({ error_message: message, updated_at: new Date().toISOString() })
      .eq('id', invoiceId)
      .in('status', ['draft', 'tax_calculated'])
    await logInvoiceEvent(invoiceId, 'tax_failed', gate.auth.user.id, { error: message })
    return { success: false, error: message }
  }

  const applied = applyTaxResponses(taxableLines, results)
  if (!applied.ok) {
    await admin.from('customer_invoices').update({ error_message: applied.error, updated_at: new Date().toISOString() })
      .eq('id', invoiceId)
      .in('status', ['draft', 'tax_calculated'])
    await logInvoiceEvent(invoiceId, 'tax_failed', gate.auth.user.id, { error: applied.error })
    return { success: false, error: applied.error }
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
      is_collection: invoice.is_collection,
    },
  )

  // One transaction, guarded on status AND on the hash the calculation was
  // performed against: a save that landed mid-calculation (which replaces the
  // line rows entirely) makes this fail rather than write stale tax.
  const { error: applyError } = await admin.rpc('apply_customer_invoice_tax', {
    p_invoice_id: invoiceId,
    p_expected_hash: hash,
    p_line_tax: applied.lines,
    p_totals: {
      subtotal,
      shipping_total: shippingTotal,
      tax_total: taxTotal,
      total,
      collected: invoice.is_collection,
      warnings: [...collectionWarnings(taxableLines, invoice.is_collection), ...applied.warnings],
    },
    p_request: results.map((r) => ({ depot: r.group.depot, request: r.group.request })),
    p_response: results.map((r) => ({ depot: r.group.depot, response: r.response })),
    p_actor: gate.auth.user.id,
  })
  if (applyError) {
    const message = /STALE_CALCULATION/.test(applyError.message ?? '')
      ? 'The invoice changed while tax was being calculated. Recalculate.'
      : /INVALID_STATUS/.test(applyError.message ?? '')
        ? 'The invoice changed under you. Refresh and try again.'
        : 'Could not save the calculated tax.'
    return { success: false, error: message }
  }

  revalidatePath('/invoicing/accepted')
  revalidatePath('/invoicing/drafts')
  revalidatePath(`/invoicing/${invoice.hubspot_deal_id}`)
  return {
    success: true,
    taxTotal,
    total,
    warnings: [...collectionWarnings(taxableLines, invoice.is_collection), ...applied.warnings],
  }
}
