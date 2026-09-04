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
import { parseLineTracking, toXeroTracking } from '@/lib/customer-invoice/tracking'
import { dueDateFromTerms } from '@/lib/customer-invoice/payment-terms'
import { xeroFindContact } from '@/lib/xero-hub'
import { renderInvoicePdf } from './document-data'
import { closeDealWon } from '@/app/actions/hubspot/closeDealWon'
import {
  requireInvoicingManage,
  loadInvoiceWithLines,
  logInvoiceEvent,
} from '@/app/actions/invoicing/shared'

const Input = z.object({
  invoiceId: z.string().uuid(),
})

export type SendToXeroResult =
  | { success: true; xeroInvoiceNumber: string; warnings: string[] }
  | { success: false; error: string }

interface N8nAuthorizeResponse {
  xero_invoice_id?: string
  xero_invoice_number?: string
  error?: string
}

export async function sendInvoiceToXero(input: { invoiceId: string }): Promise<SendToXeroResult> {
  const gate = await requireInvoicingManage()
  if (!gate.ok) return { success: false, error: gate.error }

  const parsed = Input.safeParse(input)
  if (!parsed.success) return { success: false, error: 'Invalid input' }
  const { invoiceId } = parsed.data

  const webhookUrl = process.env.N8N_CUSTOMER_INVOICE_WEBHOOK_URL
  if (!webhookUrl) return { success: false, error: 'The invoice webhook is not configured on the server.' }

  const loaded = await loadInvoiceWithLines(invoiceId)
  if (!loaded.ok) return { success: false, error: loaded.error }
  const { invoice, lines } = loaded

  // Xero is now the LAST step, after the customer already has their PDF. The
  // ledger should only carry invoices that actually went out.
  if (invoice.status !== 'sent') {
    return {
      success: false,
      error: `The invoice has to be emailed to the customer before it goes to Xero (this one is ${invoice.status}).`,
    }
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

  // Every line must carry a revenue account. A line with none is NOT rejected
  // by Xero: the payload builder simply omits AccountCode and Xero posts the
  // revenue to the org's default sales account, silently and in the wrong
  // place. That is the failure this blocks.
  //
  // It happens when a rep picks a product with no Xero mapping (SKUs like
  // 01-EBH9 or H8 against 60 US line items today), which is exactly what the
  // Quotes Hub exists to stop at source. Until every deal comes through it,
  // the account code is editable in the editor, so this is a prompt to fill it
  // in rather than a dead end.
  const unaccounted = lines.filter((l) => !l.account_code?.trim())
  if (unaccounted.length > 0) {
    const named = unaccounted.map((l) => `${l.name}${l.sku ? ` (${l.sku})` : ''}`).join(', ')
    return {
      success: false,
      error:
        `${unaccounted.length} line${unaccounted.length === 1 ? '' : 's'} ha${unaccounted.length === 1 ? 's' : 've'} no Xero account code, ` +
        `so the revenue would post to the default sales account: ${named}. ` +
        `Type the Xero item code on each of those lines and the account fills itself in, then press Save Xero codes. ` +
        `Both fields stay editable at this stage even though the rest of the invoice is frozen.`,
    }
  }

  // A collected order carries no delivery address requirement: it was taxed
  // at the depot and is invoiced the same way.
  if (!invoice.is_collection) {
    const address = sanitizeUSAddress({
      street: invoice.delivery_street ?? '',
      city: invoice.delivery_city ?? '',
      state: invoice.delivery_state ?? '',
      zip: invoice.delivery_zip ?? '',
    })
    if (!address.ok) return { success: false, error: address.error }
  }

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
      is_collection: invoice.is_collection,
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
    .eq('status', 'sent')
    .select('id')
  if (casError || !cas || cas.length === 0) {
    return { success: false, error: 'This invoice is already being sent to Xero.' }
  }
  await logInvoiceEvent(invoiceId, 'authorize_requested', gate.auth.user.id, {
    collected: invoice.is_collection,
  })

  // Allocate the customer-facing EBUS number. Done here, not at draft, so an
  // abandoned draft never burns one, and done through the RPC so the counter
  // increments inside a transaction that can give the number back. Idempotent:
  // an invoice that already has a number keeps it, so a retry after a timeout
  // cannot produce a second number for the same sale.
  const { data: raised, error: raiseError } = await admin.rpc('raise_customer_invoice', {
    p_invoice_id: invoiceId,
    p_expected_hash: currentHash,
    p_actor: gate.auth.user.id,
  })
  if (raiseError || !raised?.invoice_number) {
    const detail = raiseError?.message ?? ''
    const message = /STALE_CALCULATION/.test(detail)
      ? 'The invoice changed since tax was calculated. Recalculate tax first.'
      : /INVALID_STATUS/.test(detail)
        ? 'The invoice changed under you. Refresh and try again.'
        : 'Could not allocate an invoice number. Nothing was sent.'
    await admin
      .from('customer_invoices')
      .update({ status: 'sent', error_message: message, updated_at: new Date().toISOString() })
      .eq('id', invoiceId)
      .eq('status', 'authorizing')
    return { success: false, error: message }
  }
  const invoiceNumber = String(raised.invoice_number)

  // The invoice date is the date the invoice actually goes out, NOT the date
  // the draft was opened, so it is stamped here rather than defaulted at
  // creation. The due date follows from it: the contact's Xero payment terms
  // if it has any, otherwise Net 30. A due date Dave set by hand is left alone.
  // A failed contact lookup falls back to Net 30 rather than blocking a send.
  const today = new Date().toISOString().slice(0, 10)
  // Drafts carry NO invoice date: the column has no default and the editor
  // shows it blank, because the invoice date is the date the invoice goes out.
  // A date set by hand is respected, exactly as a hand-set due date is.
  const invoiceDate = invoice.invoice_date ?? today
  let dueDate = invoice.due_date
  if (!dueDate) {
    const contact = await xeroFindContact(invoice.taxjar_customer_id)
    dueDate = dueDateFromTerms(invoiceDate, contact.ok && contact.data ? contact.data.payment_terms : null)
  }
  await admin
    .from('customer_invoices')
    .update({ invoice_date: invoiceDate, due_date: dueDate, updated_at: new Date().toISOString() })
    .eq('id', invoiceId)

  // Rendered before the payload is built. A failure here must NOT stop the
  // invoice reaching Xero: the books matter more than the attachment, and the
  // customer already has the document. Warned about instead, below.
  let pdf: { filename: string; bytes: Buffer } | null = null
  let pdfError: string | null = null
  try {
    pdf = await renderInvoicePdf(invoice, lines)
  } catch (err) {
    pdfError = err instanceof Error ? err.message : String(err)
    console.error('send-to-xero PDF render failed', pdfError)
  }

  const payload = {
    idempotency_key: invoice.idempotency_key,
    invoice_id: invoice.id,
    // OUR number, always passed explicitly. Xero assigns one from its own
    // live sequence to anything posted without it, and that number is then
    // burned even if the invoice is deleted.
    invoice_number: invoiceNumber,
    holding_reference: invoice.holding_reference,
    // AUTHORISED, not DRAFT.
    //
    // The old comment here promised a later flip to AUTHORISED. That flip was
    // never built: xero_status was written as DRAFT in this one place and
    // nothing anywhere ever changed it, so every invoice sat in Xero as a draft
    // for good, out of the ledger and out of the aged receivables.
    //
    // Authorising here is safe because the document has ALREADY gone out: this
    // action refuses to run unless the invoice status is 'sent', which is set
    // only after the customer has been emailed the PDF. So the ledger still
    // never carries an invoice the customer has not seen, which is what the
    // draft was protecting.
    //
    // And it is safe on Xero's terms. Xero validates a supplied SubTotal and
    // TotalTax against its own calculated line totals on an AUTHORISED invoice
    // and ignores them on a draft, which would be the thing to fear here since
    // the tax comes from TaxJar rather than from Xero. This payload sends
    // neither: `totals` below is carried for n8n's own use and is not mapped
    // into the Xero body. Xero only ever sees per-line TaxAmount with TaxType
    // NONE, which was verified live against Echo Barrier USA LLC.
    //
    // n8n already honours this: Build Invoice Payload reads body.xero_status
    // and posts AUTHORISED when it says so, DRAFT otherwise. No n8n change was
    // needed for the flip itself.
    xero_status: 'AUTHORISED' as const,
    hubspot_deal_id: invoice.hubspot_deal_id,
    quote_reference: null as string | null,
    reference: invoice.customer_po_number ?? '',
    // Forward-compatible only: n8n never sends an address to Xero, and Xero is
    // handed per-line TaxAmount with TaxType NONE so it computes nothing. This
    // lets a later branding change name the collection depot without a Hub
    // deploy.
    is_collection: invoice.is_collection,
    collection_depots: invoice.is_collection
      ? [...new Set(lines.filter((l) => !l.is_shipping).map((l) => l.ship_from_depot))]
      : [],
    contact: {
      xero_account_number: invoice.taxjar_customer_id,
      hubspot_company_id: invoice.hubspot_company_id,
      company_name: invoice.company_name,
    },
    currency: invoice.currency,
    date: invoiceDate,
    due_date: dueDate,
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
        // Xero's LineItem.Tracking shape, built here rather than in n8n so the
        // mapping is versioned and testable. Xero's own spec caps this at two
        // elements per line; toXeroTracking enforces that.
        tracking: toXeroTracking(parseLineTracking(l.tracking)),
      })),
    shipping_lines: lines
      .filter((l) => l.is_shipping)
      .map((l) => ({
        item_code: l.xero_item_code,
        account_code: l.account_code,
        description: l.description || l.name,
        quantity: Number(l.quantity),
        unit_amount: Number(l.unit_price),
        // Freight can be discounted too; without this Xero would bill the
        // undiscounted price while our stored total and the tax base used the
        // discounted one.
        discount_rate: Number(l.discount_percentage),
        tax_amount: Number(l.tax_amount ?? 0),
        tracking: toXeroTracking(parseLineTracking(l.tracking)),
      })),
    totals: {
      subtotal: Number(invoice.subtotal ?? 0),
      shipping_total: Number(invoice.shipping_total ?? 0),
      tax_total: Number(invoice.tax_total ?? 0),
      total: Number(invoice.total ?? 0),
    },
    // RETIRED, and deliberately still sent as a hardcoded false rather than
    // dropped. Dean's decision on 2026-09-03: the customer-facing invoice is a
    // PDF from the Hub, emailed to the contact by us. Xero is the books only
    // and must never email the customer. Sending an explicit false means the
    // n8n Xero email branch can never see a truthy value, even if the branch
    // itself is still wired up over there.
    email_to_customer: false,
    // The customer's invoice PDF, for n8n to PUT onto the Xero invoice
    // (PUT /Invoices/{id}/Attachments/{FileName}, application/octet-stream,
    // scope accounting.attachments). Xero's IncludeOnline defaults to false, so
    // this is an internal record on the books and is NOT shown to the customer
    // on Xero's online invoice: they already have this exact file by email.
    //
    // Sent as base64 rather than a signed URL. The 1 MB server-action body
    // limit does not apply here: this is a server-to-server fetch, not a client
    // action payload. Re-rendered rather than stored, the same deterministic
    // render the email sent, so the bytes on the ledger are the bytes the
    // customer holds.
    attachment: pdf ? { filename: pdf.filename, content_base64: pdf.bytes.toString('base64') } : null,
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
    let res: Response
    try {
      res = await fetch(webhookUrl, {
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
    } catch (networkErr) {
      // Distinguish "never left the building" from "we do not know". Only a
      // connection-level failure that is NOT an abort proves nothing was
      // created, and only that case is safe to release immediately.
      const aborted = networkErr instanceof Error && networkErr.name === 'AbortError'
      throw Object.assign(new Error(aborted ? 'timeout' : 'unreachable'), {
        cause: networkErr,
        dispatched: aborted,
      })
    } finally {
      clearTimeout(timer)
    }

    if (!res.ok) throw Object.assign(new Error(`webhook HTTP ${res.status}`), { dispatched: true })
    response = (await res.json()) as N8nAuthorizeResponse
    if (!response.xero_invoice_id || !response.xero_invoice_number) {
      throw Object.assign(new Error(response.error || 'webhook returned no invoice ids'), { dispatched: true })
    }
  } catch (err) {
    const dispatched = Boolean((err as { dispatched?: boolean }).dispatched)
    const detail = err instanceof Error ? err.message : 'unknown error'
    const message = dispatched
      ? `Sending to Xero did not complete (${detail}). The invoice may already exist in Xero, so it stays locked; use Reconcile to check once n8n has settled.`
      : `Sending to Xero failed before it reached n8n (${detail}). Nothing was created; try again.`

    // Releasing an invoice we are not certain about would let a second Send
    // race an in-flight n8n run and create a duplicate in Xero. Only a
    // provably-undispatched request is released here; everything else stays in
    // `authorizing` for the Reconcile control, which adopts the Xero ids if
    // n8n wrote them back and otherwise releases after 10 minutes.
    await admin
      .from('customer_invoices')
      .update({
        ...(dispatched ? {} : { status: 'sent' }),
        error_message: message,
        updated_at: new Date().toISOString(),
      })
      .eq('id', invoiceId)
      .eq('status', 'authorizing')
    await logInvoiceEvent(invoiceId, 'authorize_failed', gate.auth.user.id, { error: message, dispatched })
    return { success: false, error: message }
  }

  // The invoice now exists in Xero as an AUTHORISED invoice carrying our
  // number, with the customer's PDF attached to it, and the customer already
  // had that PDF by email before this action would run.
  const now = new Date().toISOString()
  await admin
    .from('customer_invoices')
    .update({
      status: 'completed',
      xero_invoice_id: response.xero_invoice_id,
      xero_invoice_number: response.xero_invoice_number,
      error_message: null,
      updated_by_uid: gate.auth.user.id,
      updated_at: now,
    })
    .eq('id', invoiceId)
    .eq('status', 'authorizing')
  await logInvoiceEvent(invoiceId, 'xero_invoice_authorised', gate.auth.user.id, {
    invoice_number: invoiceNumber,
    xero_invoice_id: response.xero_invoice_id,
  })

  // The deal is done: it has been quoted, accepted, invoiced, the document has
  // gone to the customer and the invoice is on the ledger. Dean's call that
  // this is the point it becomes Closed Won.
  //
  // AFTER the invoice row is marked completed, and never allowed to undo it. A
  // HubSpot failure here leaves a correct invoice and a stale deal stage, which
  // a human can fix in one click; the reverse would leave the Hub thinking an
  // authorised Xero invoice had not been created.
  const closedWon = await closeDealWon(invoice.hubspot_deal_id)

  // Filing is deliberately NOT done here. A TaxJar order transaction is the
  // record that reports the sale on a return, and it is keyed on the invoice
  // number, so it must not be created as a side effect of drafting: a draft
  // that is later discarded would leave a filed sale behind. Send to TaxJar
  // does it explicitly, once the number exists.
  const warnings: string[] = [
    `Invoice ${invoiceNumber} is AUTHORISED in Xero and has not been filed to TaxJar. Use Send to TaxJar to file it.`,
  ]
  if (pdfError) {
    warnings.push(
      'The invoice PDF could not be rendered, so it is not attached to the Xero invoice. The customer still has the copy that was emailed.',
    )
  }
  if (!closedWon.success) {
    warnings.push(
      `The invoice is on the Xero ledger, but the HubSpot deal could not be moved to Closed won (${closedWon.error}). Move it by hand.`,
    )
  }

  revalidatePath('/invoicing/sent')
  revalidatePath('/invoicing/completed')
  revalidatePath(`/invoicing/${invoice.hubspot_deal_id}`)
  return { success: true, xeroInvoiceNumber: invoiceNumber, warnings }
}

