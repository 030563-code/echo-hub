'use server'

/**
 * Mark the invoice as sent WITHOUT emailing it: the other door out of step 4.
 *
 * Dean, 11 Sep 2026: "there needs to be a mark as sent button too next to the
 * send to email which also marks it as sent, because some customers don't get
 * sent via email." Some accounts receive the PDF by hand, through a portal, or
 * on paper with the goods. For those the Hub still needs to record that the
 * customer has the document, because Send to Xero refuses to run until they
 * do, and the ledger should only carry invoices that actually went out.
 *
 * Same transition as emailInvoiceToCustomer, documented -> sent, with the same
 * single-winner conditional update. What it deliberately does NOT do is touch
 * emailed_at, emailed_to or emailed_was_test: those three record an email that
 * left the building, and there was none. A blank emailed_at on a sent invoice
 * is the honest record of "handed over some other way", and the audit row says
 * so in words.
 */

import { z } from 'zod'
import { revalidatePath } from 'next/cache'
import { createAdminClient } from '@/lib/supabase/admin'
import { applyStockMovements } from '@/lib/stock/apply'
import { buildDispatchMovements } from '@/lib/stock/movements'
import { requireInvoicingManage, loadInvoiceWithLines, logInvoiceEvent } from './shared'

const Input = z.object({ invoiceId: z.string().uuid() })

export type MarkSentResult = { success: true } | { success: false; error: string }

export async function markInvoiceSent(input: { invoiceId: string }): Promise<MarkSentResult> {
  const gate = await requireInvoicingManage()
  if (!gate.ok) return { success: false, error: gate.error }

  const parsed = Input.safeParse(input)
  if (!parsed.success) return { success: false, error: 'Invalid invoice id' }
  const { invoiceId } = parsed.data

  const loaded = await loadInvoiceWithLines(invoiceId)
  if (!loaded.ok) return { success: false, error: loaded.error }
  const { invoice, lines } = loaded

  // The document has to exist before anyone can have been given it. Same gate
  // as the email path, same wording shape.
  if (invoice.status !== 'documented') {
    return {
      success: false,
      error: `The invoice document has to be generated before it can be marked as sent (this one is ${invoice.status}).`,
    }
  }

  const admin = createAdminClient()
  const now = new Date().toISOString()
  // Single winner: two clicks, or a click racing the email button, leave
  // exactly one transition. The loser gets no row back and reports it.
  const { data: won, error } = await admin
    .from('customer_invoices')
    .update({ status: 'sent', updated_by_uid: gate.auth.user.id, updated_at: now })
    .eq('id', invoiceId)
    .eq('status', 'documented')
    .select('id')
  if (error) return { success: false, error: 'The invoice could not be updated.' }
  if (!won || won.length === 0) {
    return { success: false, error: 'This invoice has already moved on; reload to see its current step.' }
  }

  // Same ledger deduction as the email door (D3): marked as sent means the
  // customer has the goods, however the document reached them.
  const ledger = await applyStockMovements(admin, buildDispatchMovements(invoiceId, lines), gate.auth.user.id)
  if (!ledger.ok) console.error('customer dispatch ledger failed', invoiceId, ledger.error)

  await logInvoiceEvent(invoiceId, 'invoice_marked_sent', gate.auth.user.id, {
    note: 'Marked as sent by hand; no email was sent from the Hub.',
  })

  revalidatePath('/invoicing/documented')
  revalidatePath('/invoicing/sent')
  revalidatePath(`/invoicing/${invoice.hubspot_deal_id}`)
  return { success: true }
}
