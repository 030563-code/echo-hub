'use server'

/**
 * "Save and calculate tax", for an organisation whose tax is priced by Xero.
 *
 * The French sibling of calculate-tax.ts. Where the USA asks TaxJar what the
 * destination sales tax is and later posts that AMOUNT to Xero against a 0%
 * rate, France posts a DRAFT invoice to Xero carrying an explicit TaxType on
 * every line, lets Xero compute the TVA, and reads the figures back. Nothing is
 * filed anywhere: the draft is the pricing step, and the authorised invoice at
 * the end of the ladder IS the record.
 *
 * Dean, 22 Sep 2026: "it creates a draft invoice in Xero then returns tax lines
 * if xero adds them", keeping the same order as the USA. So this stands exactly
 * where the TaxJar call stands, writes through the same RPC, and leaves the
 * invoice at `tax_calculated` like its sibling does.
 *
 * 🔴 THREE THINGS THIS MUST NEVER DO, each learned the hard way:
 *
 * 1. Post a line with no TaxType. Read live from Echo Barrier SAS on 22 Sep
 *    2026: 20 of its 21 revenue accounts default to OUTPUT at 0%, so a draft
 *    posted with no TaxType comes back zero-rated, answers 200, and would carry
 *    an invoice understated by 20% through every later step without a word.
 *    The profile's xeroTaxType goes on every line, and a zero back on a priced
 *    line is REFUSED below rather than stored.
 * 2. Send a TaxAmount. Xero treats a supplied amount as an override of its own
 *    figure, silently (proven live 2026-09-01: it stored 1125 over its own
 *    875). Zero is a supplied amount. The n8n node leaves the KEY off.
 * 3. Map the returned tax onto our lines by position. Every line travels with
 *    its line_key and comes back with it, and a line that does not come back
 *    fails the whole calculation rather than being zeroed by the RPC.
 */

import { z } from 'zod'
import { revalidatePath } from 'next/cache'
import { createAdminClient } from '@/lib/supabase/admin'
import { sanitizeDeliveryAddress } from '@/lib/delivery-address'
import { invoicingProfile } from '@/lib/customer-invoice/invoicing-profile'
import { linesHash } from '@/lib/customer-invoice/hash'
import { parseLineTracking, toXeroTracking } from '@/lib/customer-invoice/tracking'
import { roundCents } from '@/lib/quote-math'
import { xeroCreateDraftInvoice, type XeroDraftInput, type XeroDraftLineInput } from '@/lib/xero-hub'
import { orgLabel } from '@/lib/organisations'
import { requireInvoicingManage, loadInvoiceWithLines, logInvoiceEvent } from '@/app/actions/invoicing/shared'
import type { CalculateTaxResult } from './calculate-tax'

const Input = z.object({ invoiceId: z.string().uuid() })

export async function calculateInvoiceTaxXero(input: { invoiceId: string }): Promise<CalculateTaxResult> {
  const gate = await requireInvoicingManage()
  if (!gate.ok) return { success: false, error: gate.error }

  const parsed = Input.safeParse(input)
  if (!parsed.success) return { success: false, error: 'Invalid invoice id' }
  const { invoiceId } = parsed.data

  const loaded = await loadInvoiceWithLines(invoiceId, gate.auth.profile.organisations)
  if (!loaded.ok) return { success: false, error: loaded.error }
  const { invoice, lines } = loaded

  const profile = invoicingProfile(invoice.organisation_code)
  if (!profile || profile.taxEngine !== 'xero_draft') {
    return { success: false, error: `${orgLabel(invoice.organisation_code)} does not price its tax through a Xero draft.` }
  }
  // Canada prices its tax this way too, but its Xero leg does not exist yet.
  // Refused before anything is written, so a press of the button leaves the
  // invoice exactly as it was.
  if (profile.xeroNotConnected) return { success: false, error: profile.xeroNotConnected }

  if (invoice.status !== 'draft' && invoice.status !== 'tax_calculated') {
    return { success: false, error: `Tax can only be calculated on a draft (this invoice is ${invoice.status}).` }
  }
  if (invoice.currency !== profile.currency) {
    return { success: false, error: `${orgLabel(profile.org)} invoices are ${profile.currency} (this one is ${invoice.currency}).` }
  }
  if (lines.length === 0) return { success: false, error: 'This invoice has no lines, so there is nothing to price.' }

  // A collected order is priced without a delivery address, exactly as the USA
  // does it. Only a delivered order needs one, in this country's shape.
  if (!invoice.is_collection) {
    const address = sanitizeDeliveryAddress(profile.country, {
      street: invoice.delivery_street,
      city: invoice.delivery_city,
      state: invoice.delivery_state,
      zip: invoice.delivery_zip,
    })
    if (!address.ok) return { success: false, error: address.error }
  }

  // Unlike TaxJar, a Xero draft needs a CONTACT, and the contact is resolved
  // from the account number. So what the USA only needs at Send to Xero, France
  // needs here, at the first step that touches Xero.
  if (!invoice.taxjar_customer_id) {
    return {
      success: false,
      error: 'This company has no Xero account code yet, so Xero cannot price the draft. Set the account code on the invoice first.',
    }
  }

  const admin = createAdminClient()
  const today = new Date().toISOString().slice(0, 10)

  const toDraftLine = (l: (typeof lines)[number]): XeroDraftLineInput => ({
    line_key: l.line_key,
    item_code: l.xero_item_code?.trim() || null,
    account_code: l.account_code?.trim() || null,
    description: l.description || l.name,
    quantity: Number(l.quantity),
    unit_amount: Number(l.unit_price),
    discount_rate: Number(l.discount_percentage),
    tracking: toXeroTracking(parseLineTracking(l.tracking)),
  })

  const request: XeroDraftInput = {
    idempotency_key: invoice.idempotency_key,
    invoice_id: invoice.id,
    // The holding reference until the real number exists. The authorise leg
    // rewrites it on the same Xero InvoiceID. Never absent: Xero would mint
    // one from its own sequence and burn it.
    invoice_number: invoice.invoice_number ?? invoice.holding_reference,
    xero_draft_invoice_id: invoice.xero_draft_invoice_id ?? null,
    hubspot_deal_id: invoice.hubspot_deal_id,
    reference: invoice.customer_po_number ?? '',
    contact: {
      xero_account_number: invoice.taxjar_customer_id,
      hubspot_company_id: invoice.hubspot_company_id,
      company_name: invoice.company_name,
    },
    currency: invoice.currency,
    date: invoice.invoice_date ?? today,
    due_date: invoice.due_date,
    tax_type: profile.xeroTaxType,
    lines: lines.filter((l) => !l.is_shipping).map(toDraftLine),
    shipping_lines: lines.filter((l) => l.is_shipping).map(toDraftLine),
  }

  const failed = async (message: string, extra?: Record<string, unknown>) => {
    await admin
      .from('customer_invoices')
      .update({ error_message: message, updated_at: new Date().toISOString() })
      .eq('id', invoiceId)
      .in('status', ['draft', 'tax_calculated'])
    await logInvoiceEvent(invoiceId, 'tax_failed', gate.auth.user.id, { error: message, engine: 'xero_draft', ...extra })
    return { success: false as const, error: message }
  }

  const res = await xeroCreateDraftInvoice(profile.org, request)
  if (!res.ok) return failed(`Xero could not price the draft: ${res.error}`)
  const draft = res.data

  // The draft exists in Xero now, whatever happens next. Remember its id
  // immediately, so a recalculation updates THIS draft instead of leaving an
  // orphan and creating a second one. Kept separate from xero_invoice_id, which
  // means "authorised" and is refused or short-circuited on by three places.
  await admin
    .from('customer_invoices')
    .update({ xero_draft_invoice_id: draft.xero_draft_invoice_id, updated_at: new Date().toISOString() })
    .eq('id', invoiceId)
    .in('status', ['draft', 'tax_calculated'])

  if (String(draft.status ?? '').toUpperCase() !== 'DRAFT') {
    return failed(
      `The Xero invoice ${draft.xero_invoice_number ?? draft.xero_draft_invoice_id} is ${draft.status}, not a draft, so it cannot be repriced. Check it in Xero.`,
      { xero_status: draft.status },
    )
  }

  // --- Read the tax back, by identity, and refuse anything that does not add up ---
  const returned = new Map(draft.lines.map((l) => [String(l.line_key), l]))
  const warnings: string[] = []
  const lineTax: { line_key: string; tax_amount: number; taxable_amount: number | null; combined_tax_rate: number | null }[] = []

  for (const line of lines) {
    const back = returned.get(line.line_key)
    if (!back) return failed(`Xero returned no figures for line ${line.line_key} (${line.name}).`)

    const ours = roundCents(Number(line.line_total))
    const theirs = roundCents(Number(back.line_amount))
    if (Math.abs(ours - theirs) > 0.01) {
      return failed(
        `Xero prices line ${line.name} at ${theirs.toFixed(2)} but the invoice says ${ours.toFixed(2)}. The two must agree to the cent before any tax is trusted.`,
        { line_key: line.line_key, ours, theirs },
      )
    }

    const tax = roundCents(Number(back.tax_amount))
    // 🔴 THE TRAP. A priced line with zero TVA is not "exempt", it is a draft
    // Xero zero-rated because the TaxType did not take. It would look fine on
    // every screen and be wrong on the ledger.
    if (ours > 0 && tax === 0) {
      return failed(
        `Xero returned no ${profile.taxLabel} on ${line.name} even though tax type ${profile.xeroTaxType} was sent. The draft is zero-rated; check the rate on that tax type in Xero before continuing.`,
        { line_key: line.line_key, tax_type: back.tax_type },
      )
    }
    if (back.tax_type && back.tax_type !== profile.xeroTaxType) {
      warnings.push(`Xero recorded ${line.name} under tax type ${back.tax_type}, not ${profile.xeroTaxType}.`)
    }

    lineTax.push({
      line_key: line.line_key,
      tax_amount: tax,
      taxable_amount: theirs,
      combined_tax_rate: theirs > 0 ? Math.round((tax / theirs) * 10_000) / 10_000 : null,
    })
  }

  if (returned.size !== lines.length) {
    warnings.push(`Xero returned ${returned.size} lines for ${lines.length} sent; the extras were ignored.`)
  }

  const subtotal = roundCents(lines.filter((l) => !l.is_shipping).reduce((a, l) => a + Number(l.line_total), 0))
  const shippingTotal = roundCents(lines.filter((l) => l.is_shipping).reduce((a, l) => a + Number(l.line_total), 0))
  const taxTotal = roundCents(lineTax.reduce((a, l) => a + l.tax_amount, 0))
  const total = roundCents(subtotal + shippingTotal + taxTotal)

  const xeroTaxTotal = roundCents(Number(draft.total_tax))
  if (Math.abs(xeroTaxTotal - taxTotal) > 0.01) {
    warnings.push(
      `Per-line ${profile.taxLabel} sums to ${taxTotal.toFixed(2)} but Xero's total is ${xeroTaxTotal.toFixed(2)} (difference ${roundCents(taxTotal - xeroTaxTotal).toFixed(2)}). Per-line values are used; review before sending.`,
    )
  }

  // Hash computed from the server-stored lines and address the draft was priced
  // against, exactly as the TaxJar step does, so the same staleness guard holds.
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

  // Same RPC as the USA, same guards. The request and response go into the
  // taxjar_* columns: they are plain jsonb, and the `engine` field inside says
  // what they hold. Renaming the columns would touch 25 live USA rows for a
  // label.
  const { error: applyError } = await admin.rpc('apply_customer_invoice_tax', {
    p_invoice_id: invoiceId,
    p_expected_hash: hash,
    p_line_tax: lineTax,
    p_totals: { subtotal, shipping_total: shippingTotal, tax_total: taxTotal, total, collected: invoice.is_collection, warnings },
    p_request: { engine: 'xero_draft', organisation: profile.org, request },
    p_response: { engine: 'xero_draft', organisation: profile.org, response: draft },
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
  return { success: true, taxTotal, total, warnings }
}
