'use server'

import { z } from 'zod'
import { revalidatePath } from 'next/cache'
import { createAdminClient } from '@/lib/supabase/admin'
import { xeroItemAccounts } from '@/lib/xero-hub'
import { loadInvoiceWithLines, requireInvoicingManage } from './shared'

/**
 * Editing the Xero CODING on an invoice that is otherwise frozen.
 *
 * Dean, 2026-09-03: "the invoice itself is uneditable after send to customer,
 * this is also fair however I think for things that are more internal like the
 * Account code/Xero Item code it should be editable."
 *
 * He is right, and the reason is worth writing down. Freezing the invoice at
 * 'sent' protects the document the CUSTOMER is holding. The item code and the
 * account code are not on that document at all:
 *
 *   - `linesHash` (src/lib/customer-invoice/hash.ts) hashes line_key, sku,
 *     quantity, unit price, discount, is_shipping and ship_from_depot. Neither
 *     coding field is in it, so changing them cannot invalidate a tax
 *     calculation or trip the staleness guard.
 *   - The PDF renders neither field, so changing them cannot make the emailed
 *     document disagree with the stored record, which is what pdf_sha256 exists
 *     to catch.
 *
 * They are purely the Hub's instruction to Xero about which revenue account the
 * line lands in, and until Send to Xero has actually run, that instruction has
 * had no effect on anything. Blocking it only forced Dave to rebuild an invoice
 * from scratch to fix a one-line mapping.
 */

const Input = z.object({
  invoiceId: z.string().uuid(),
  lines: z
    .array(
      z.object({
        line_key: z.string().min(1),
        // Trimmed to null rather than kept as '': the send-to-Xero guard tests
        // for a blank account, and ' ' would slip past a truthiness check.
        xero_item_code: z.string().trim().max(200).nullable(),
        account_code: z.string().trim().max(50).nullable(),
      }),
    )
    .min(1)
    .max(200),
})

/**
 * Statuses at which the coding may still be changed.
 *
 * Everything up to and including 'sent'. NOT 'completed': the invoice is in
 * Xero by then and the account code has already done its job, so editing the
 * Hub's copy would only make the two disagree with no way to tell which was
 * used. NOT 'authorizing' either, because that call is in flight and reading
 * the row mid-change is exactly the race the status exists to prevent.
 */
const CODING_EDITABLE_STATUSES = new Set(['draft', 'tax_calculated', 'filed', 'documented', 'sent'])

export type SaveCodingResult = { success: true; updated: number } | { success: false; error: string }

export async function saveInvoiceCoding(input: unknown): Promise<SaveCodingResult> {
  const gate = await requireInvoicingManage()
  if (!gate.ok) return { success: false, error: gate.error }

  const parsed = Input.safeParse(input)
  if (!parsed.success) {
    return { success: false, error: parsed.error.issues[0]?.message ?? 'Invalid coding data' }
  }
  const { invoiceId, lines } = parsed.data

  const keys = new Set(lines.map((l) => l.line_key))
  if (keys.size !== lines.length) return { success: false, error: 'Line keys must be unique.' }

  const loaded = await loadInvoiceWithLines(invoiceId)
  if (!loaded.ok) return { success: false, error: loaded.error }
  const { invoice, lines: storedLines } = loaded

  if (!CODING_EDITABLE_STATUSES.has(invoice.status)) {
    return {
      success: false,
      error:
        invoice.status === 'completed'
          ? 'This invoice is already in Xero, so its codes can no longer be changed here. Change the account on the invoice in Xero instead.'
          : `This invoice is ${invoice.status}, so its Xero codes cannot be changed right now.`,
    }
  }

  // Only lines that actually belong to THIS invoice. The line_key comes from
  // the browser, and without this a crafted payload could recode another
  // invoice's line by guessing its key.
  const storedKeys = new Set(storedLines.map((l) => l.line_key))
  const unknown = lines.filter((l) => !storedKeys.has(l.line_key))
  if (unknown.length > 0) {
    return { success: false, error: 'Those lines are not on this invoice. Reload the page and try again.' }
  }

  const admin = createAdminClient()
  let updated = 0
  for (const line of lines) {
    const { error } = await admin
      .from('customer_invoice_lines')
      .update({
        xero_item_code: line.xero_item_code || null,
        account_code: line.account_code || null,
      })
      .eq('invoice_id', invoiceId)
      .eq('line_key', line.line_key)
    if (error) {
      console.error('saveInvoiceCoding update failed', { invoiceId, lineKey: line.line_key, error: error.message })
      return { success: false, error: 'Could not save the Xero codes. Please try again.' }
    }
    updated += 1
  }

  revalidatePath(`/invoicing/${invoice.hubspot_deal_id}`)
  return { success: true, updated }
}

export type ItemAccountsResult =
  | { success: true; accounts: Record<string, string | null> }
  | { success: false; error: string }

/**
 * Xero's item-to-revenue-account map, for the editor to resolve a typed item
 * code against.
 *
 * Dean: "it would be better if the account code automatically fetches and syncs
 * when you enter/reenter the Xero item code." The whole map comes back in one
 * call (107 items live) rather than one round trip per keystroke, so the editor
 * fetches it once and resolves every later edit instantly.
 *
 * A null value is a real answer, not a miss: some items genuinely carry no
 * sales account in Xero. `EBH9` is one, which is exactly the case that produced
 * the "1 line has no Xero account code" error, so the editor has to tell those
 * two situations apart rather than silently leaving the field empty.
 */
export async function getXeroItemAccounts(): Promise<ItemAccountsResult> {
  const gate = await requireInvoicingManage()
  if (!gate.ok) return { success: false, error: gate.error }

  const accounts = await xeroItemAccounts()
  if (!accounts.ok) return { success: false, error: accounts.error }
  return { success: true, accounts: accounts.data }
}
