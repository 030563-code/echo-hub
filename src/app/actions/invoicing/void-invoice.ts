'use server'

/**
 * Discard a draft (or tax-calculated) invoice. Voiding frees the one-active-
 * invoice-per-deal slot so the queue can rebuild from the deal. Anything at or
 * past `authorizing` is terminal in the Hub; corrections happen in Xero.
 */

import { z } from 'zod'
import { revalidatePath } from 'next/cache'
import { createAdminClient } from '@/lib/supabase/admin'
import { requireInvoicingManage, logInvoiceEvent } from '@/app/actions/invoicing/shared'

const Input = z.object({ invoiceId: z.string().uuid() })

export type VoidInvoiceResult = { success: true } | { success: false; error: string }

export async function voidInvoice(input: { invoiceId: string }): Promise<VoidInvoiceResult> {
  const gate = await requireInvoicingManage()
  if (!gate.ok) return { success: false, error: gate.error }

  const parsed = Input.safeParse(input)
  if (!parsed.success) return { success: false, error: 'Invalid invoice id' }
  const { invoiceId } = parsed.data

  const admin = createAdminClient()
  const { data, error } = await admin
    .from('customer_invoices')
    .update({ status: 'voided', updated_by_uid: gate.auth.user.id, updated_at: new Date().toISOString() })
    .eq('id', invoiceId)
    .in('status', ['draft', 'tax_calculated'])
    .select('hubspot_deal_id')
  if (error) return { success: false, error: 'Could not discard the invoice.' }
  if (!data || data.length === 0) {
    return { success: false, error: 'Only a draft can be discarded (this invoice has moved on or is already discarded).' }
  }

  await logInvoiceEvent(invoiceId, 'voided', gate.auth.user.id)
  revalidatePath('/invoicing/accepted')
  revalidatePath('/invoicing/drafts')
  revalidatePath(`/invoicing/${data[0].hubspot_deal_id}`)
  return { success: true }
}
