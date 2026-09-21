'use server'

import { z } from 'zod'
import { revalidatePath } from 'next/cache'
import { createAdminClient } from '@/lib/supabase/admin'
import { getAuthorizedUser } from '@/lib/authz'
import { poChainHeldBy } from '@/lib/po-organisations'
import { ARRIVAL_DEPOTS } from '@/lib/stock/warehouses'
import { arriveAtDepot, type ArrivalResult } from '@/lib/stock/arrival'

// ---------------------------------------------------------------------------
// Close a shipment: the container has arrived, choose the depot, and the
// barriers move from s.r.o. to that shelf in the ledger. The work is in
// @/lib/stock/arrival; this is the gate. Session, then capability, then
// whether this account's organisations hold the chain, then the shape.
//
// stock.edit rather than po.receive: the person closing a shipment is
// operations in Kosice (Juraj, the Operations login), not the warehouse at
// the far end, and stock.edit is the capability that already lets them move
// a stock level. po.receive is kept as the other door, because a depot that
// does hold it should be able to close its own container too.
// ---------------------------------------------------------------------------

const Schema = z.object({
  poId: z.string().uuid('Invalid PO id'),
  depot: z.enum(ARRIVAL_DEPOTS),
  note: z.string().trim().max(500).optional(),
})

export type ArriveAtDepotInput = z.infer<typeof Schema>

export async function markArrivedAtDepot(input: ArriveAtDepotInput): Promise<ArrivalResult> {
  const auth = await getAuthorizedUser()
  if (!auth.ok) return { ok: false, error: auth.error }
  if (!auth.capabilities.has('stock.edit') && !auth.capabilities.has('po.receive')) {
    return { ok: false, error: 'Forbidden: requires stock.edit or po.receive' }
  }
  const parsed = Schema.safeParse(input)
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid input' }
  if (!(await poChainHeldBy(parsed.data.poId, auth.profile.organisations))) {
    return { ok: false, error: 'Purchase order not found' }
  }

  const result = await arriveAtDepot(createAdminClient(), {
    poId: parsed.data.poId,
    depot: parsed.data.depot,
    uid: auth.user.id,
    note: parsed.data.note ?? null,
    nowIso: new Date().toISOString(),
  })
  if (result.ok) {
    revalidatePath('/purchase-orders')
    revalidatePath('/stock')
  }
  return result
}
