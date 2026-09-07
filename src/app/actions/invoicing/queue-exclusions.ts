'use server'

/**
 * Hold a deal out of the Accepted Quotes queue, and put it back.
 *
 * The queue is driven by deal_stage_history, not the deal's current stage, so
 * anything that passed through Quotation Accepted since the cutover appears
 * here forever until an invoice exists for it. A deal invoiced outside the Hub
 * therefore sits in the queue with nothing to do, and voiding a Hub invoice
 * raised against it by mistake puts it straight back.
 *
 * Nothing is deleted. The row itself is the audit trail (who, when, why), and
 * the Accepted page lists what has been set aside with an Undo, so this can
 * never become a place work silently disappears into. It is not logged to
 * customer_invoice_events because there may be no invoice to hang it on.
 */

import { z } from 'zod'
import { revalidatePath } from 'next/cache'
import { createAdminClient } from '@/lib/supabase/admin'
import { requireInvoicingManage } from '@/app/actions/invoicing/shared'

const ExcludeInput = z.object({
  dealId: z.string().trim().regex(/^\d{1,20}$/, 'That is not a HubSpot deal id'),
  reason: z.string().trim().min(1, 'Say why, so the next person knows').max(300),
})

const RestoreInput = z.object({
  dealId: z.string().trim().regex(/^\d{1,20}$/, 'That is not a HubSpot deal id'),
})

export type QueueExclusionResult = { success: true } | { success: false; error: string }

export async function excludeDealFromQueue(input: {
  dealId: string
  reason: string
}): Promise<QueueExclusionResult> {
  const gate = await requireInvoicingManage()
  if (!gate.ok) return { success: false, error: gate.error }

  const parsed = ExcludeInput.safeParse(input)
  if (!parsed.success) {
    return { success: false, error: parsed.error.issues[0]?.message ?? 'Invalid input' }
  }
  const { dealId, reason } = parsed.data

  const admin = createAdminClient()
  const { error } = await admin.from('invoicing_queue_exclusions').upsert(
    {
      hubspot_deal_id: dealId,
      reason,
      excluded_by: gate.auth.user.id,
      excluded_at: new Date().toISOString(),
    },
    { onConflict: 'hubspot_deal_id' },
  )
  if (error) return { success: false, error: 'That deal could not be set aside. Try again.' }

  revalidatePath('/invoicing/accepted')
  return { success: true }
}

export async function restoreDealToQueue(input: { dealId: string }): Promise<QueueExclusionResult> {
  const gate = await requireInvoicingManage()
  if (!gate.ok) return { success: false, error: gate.error }

  const parsed = RestoreInput.safeParse(input)
  if (!parsed.success) return { success: false, error: 'That is not a HubSpot deal id' }

  const admin = createAdminClient()
  const { error } = await admin
    .from('invoicing_queue_exclusions')
    .delete()
    .eq('hubspot_deal_id', parsed.data.dealId)
  if (error) return { success: false, error: 'That deal could not be put back. Try again.' }

  revalidatePath('/invoicing/accepted')
  return { success: true }
}
