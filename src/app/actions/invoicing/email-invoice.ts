'use server'

/**
 * Email the invoice PDF to the customer: step 4 of the pipeline.
 *
 * The send goes through n8n, not from the Hub. Dean's standing rule is that
 * mail and Xero credentials live in n8n and never in this repository, which is
 * public. The Hub posts the recipient, the body and the PDF as base64 to the
 * same webhook the Xero calls use, under a new `send_invoice_email` action.
 *
 * TEST OVERRIDE. When INVOICE_EMAIL_TEST_RECIPIENT is set, the mail is
 * redirected there and the row records that it was a test. Without that flag a
 * test send and a real one are indistinguishable afterwards, and somebody
 * eventually concludes a customer was invoiced when they were not.
 */

import { z } from 'zod'
import { revalidatePath } from 'next/cache'
import { createAdminClient } from '@/lib/supabase/admin'
import { xeroFindContact } from '@/lib/xero-hub'
import { requireInvoicingManage, loadInvoiceWithLines, logInvoiceEvent } from './shared'
import { renderInvoicePdf } from './document-data'

const Input = z.object({ invoiceId: z.string().uuid() })
const TIMEOUT_MS = 30_000

export type EmailInvoiceResult =
  | { success: true; sentTo: string; wasTest: boolean }
  | { success: false; error: string }

export async function emailInvoiceToCustomer(input: { invoiceId: string }): Promise<EmailInvoiceResult> {
  const gate = await requireInvoicingManage()
  if (!gate.ok) return { success: false, error: gate.error }

  const parsed = Input.safeParse(input)
  if (!parsed.success) return { success: false, error: 'Invalid invoice id' }
  const { invoiceId } = parsed.data

  const loaded = await loadInvoiceWithLines(invoiceId)
  if (!loaded.ok) return { success: false, error: loaded.error }
  const { invoice, lines } = loaded

  if (invoice.status !== 'documented') {
    return {
      success: false,
      error: `The invoice document has to be generated before it can be emailed (this one is ${invoice.status}).`,
    }
  }

  const webhookUrl = process.env.N8N_CUSTOMER_INVOICE_WEBHOOK_URL
  if (!webhookUrl) return { success: false, error: 'The invoice webhook is not configured on the server.' }

  // --- Recipient ---
  const testRecipient = String(process.env.INVOICE_EMAIL_TEST_RECIPIENT ?? '').trim()
  let recipient = testRecipient
  if (!recipient) {
    const contact = invoice.taxjar_customer_id ? await xeroFindContact(invoice.taxjar_customer_id) : null
    if (!contact || !contact.ok) {
      return { success: false, error: 'Xero could not be reached for the customer email address.' }
    }
    recipient = String(contact.data?.email ?? '').trim()
    if (!recipient) {
      return {
        success: false,
        error: 'The Xero contact has no email address, so there is nowhere to send the invoice. Add one on the contact card.',
      }
    }
  }

  // --- The document ---
  let rendered
  try {
    rendered = await renderInvoicePdf(invoice, lines)
  } catch (error) {
    console.error('emailInvoiceToCustomer render failed', error)
    return { success: false, error: 'The invoice could not be rendered. The error is in the server log.' }
  }

  if (rendered.remittanceIncomplete) {
    // A refusal here, unlike at Generate. A rep may want a placeholder document
    // to look at; a customer must never receive one, because it tells them
    // nothing about how to pay.
    return {
      success: false,
      error: 'The bank details are not configured, so this invoice has no payment instructions on it. Set them before emailing a customer.',
    }
  }

  // The bytes must be the bytes that were signed off at Generate. If they are
  // not, something changed underneath an issued invoice and it must not go out.
  if (invoice.pdf_sha256 && invoice.pdf_sha256 !== rendered.sha256) {
    return {
      success: false,
      error:
        'The document has changed since it was generated, so it was not sent. ' +
        'Press Regenerate PDF, check it, then email it.',
    }
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(process.env.N8N_CUSTOMER_INVOICE_WEBHOOK_SECRET
          ? { 'x-hub-secret': process.env.N8N_CUSTOMER_INVOICE_WEBHOOK_SECRET }
          : {}),
      },
      body: JSON.stringify({
        action: 'send_invoice_email',
        invoice_id: invoice.id,
        invoice_number: invoice.invoice_number,
        to: recipient,
        is_test: testRecipient !== '',
        subject: `Echo Barrier invoice ${invoice.invoice_number}`,
        body:
          `Hi,\n\nPlease find attached Echo Barrier invoice ${invoice.invoice_number}` +
          `${invoice.customer_po_number ? ` for your purchase order ${invoice.customer_po_number}` : ''}.\n\n` +
          `Payment details are on the invoice. Let me know if you need anything changed.\n\nThanks`,
        attachment: { filename: rendered.filename, content_base64: rendered.bytes.toString('base64') },
      }),
      signal: controller.signal,
      cache: 'no-store',
    })
    if (res.status === 401) {
      return { success: false, error: 'The mail webhook rejected the Hub: the webhook secret does not match n8n.' }
    }
    if (res.status === 404) {
      return {
        success: false,
        error: 'n8n has no `send_invoice_email` action yet. That branch still needs building on the n8n side.',
      }
    }
    if (!res.ok) return { success: false, error: `Sending the invoice failed (HTTP ${res.status}).` }

    const text = await res.text()
    // A workflow branch that throws answers 200 with an EMPTY body rather than
    // an error document, so an empty response has to be read as failure.
    if (text.trim() === '') {
      return { success: false, error: 'The mail workflow returned nothing, so the send cannot be confirmed.' }
    }
  } catch (error) {
    const aborted = error instanceof Error && error.name === 'AbortError'
    return {
      success: false,
      error: aborted ? 'The mail workflow did not respond in time.' : 'The mail workflow could not be reached.',
    }
  } finally {
    clearTimeout(timer)
  }

  const admin = createAdminClient()
  await admin
    .from('customer_invoices')
    .update({
      status: 'sent',
      emailed_at: new Date().toISOString(),
      emailed_to: recipient,
      emailed_was_test: testRecipient !== '',
      updated_by_uid: gate.auth.user.id,
      updated_at: new Date().toISOString(),
    })
    .eq('id', invoiceId)
    .eq('status', 'documented')

  await logInvoiceEvent(invoiceId, 'invoice_emailed', gate.auth.user.id, {
    to: recipient,
    is_test: testRecipient !== '',
    sha256: rendered.sha256,
  })

  revalidatePath('/invoicing/documented')
  revalidatePath('/invoicing/sent')
  revalidatePath(`/invoicing/${invoice.hubspot_deal_id}`)
  return { success: true, sentTo: recipient, wasTest: testRecipient !== '' }
}
