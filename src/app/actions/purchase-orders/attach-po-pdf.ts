'use server'

/**
 * Put this purchase order's PDF onto its Xero purchase order, after the fact.
 *
 * The repair path. The document normally goes on inside the same n8n run that
 * creates the Xero purchase order (decide-po sends it with the approval), so
 * this is for an order that has no document: raised before this existed, or its
 * attach failed while the order itself was created.
 *
 * Dean, 16 Sep 2026: "Make sure you dont reput the POs into Xero." So this
 * attaches and nothing else. It refuses unless the Hub row already carries the
 * Xero purchase order id that the create run wrote back, and the webhook it
 * posts to enters the workflow BELOW the Xero create, at the attachment step.
 * No path through here can create a purchase order.
 */

import { z } from 'zod'
import { revalidatePath } from 'next/cache'
import { createAdminClient } from '@/lib/supabase/admin'
import { getAuthorizedUser } from '@/lib/authz'
import { poChainHeldBy } from '@/lib/po-organisations'
import { attachPoPdfToXero } from '@/lib/xero/attach-po-pdf'
import type { PurchaseOrder } from '@/lib/erp-types'

const Input = z.object({ po_id: z.string().uuid('Invalid PO id') })

export type AttachPoPdfResult = { ok: true; description: string } | { ok: false; error: string }

export async function attachPoPdf(input: z.infer<typeof Input>): Promise<AttachPoPdfResult> {
  const auth = await getAuthorizedUser()
  if (!auth.ok) return { ok: false, error: auth.error }
  // Putting a document on the accounting ledger is the approver's act, and the
  // document is priced whatever the actor may see on screen.
  if (!auth.capabilities.has('po.approve')) {
    return { ok: false, error: 'Forbidden: missing po.approve capability' }
  }
  const parsed = Input.safeParse(input)
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid input' }
  const poId = parsed.data.po_id

  if (!(await poChainHeldBy(poId, auth.profile.organisations))) {
    return { ok: false, error: 'That purchase order no longer exists.' }
  }

  const { data: po } = await createAdminClient()
    .from('purchase_orders')
    .select('*, lines:purchase_order_lines(*)')
    .eq('id', poId)
    .maybeSingle<PurchaseOrder>()
  if (!po) return { ok: false, error: 'That purchase order no longer exists.' }

  const sent = await attachPoPdfToXero(po)
  if (!sent.ok) return sent

  revalidatePath(`/purchase-orders/${poId}`)
  return {
    ok: true,
    description: `${sent.filename} is on the Xero purchase order (${Math.round(sent.bytes / 1024)} KB).`,
  }
}
