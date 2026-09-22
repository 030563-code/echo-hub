'use server'

import { revalidatePath } from 'next/cache'
import { getAuthorizedUser } from '@/lib/authz'
import { syncAllCargo, type CargoSyncResult } from '@/lib/cargo/sync'

/**
 * Refresh every shipment from Cargo Partner, on a click.
 *
 * Gated on transport.view rather than a write capability, deliberately: this
 * writes only to the Hub's own mirror of somebody else's data, it changes
 * nothing anybody could be harmed by, and the board is useless if the person
 * looking at a container in the Atlantic cannot ask for today's position.
 *
 * NOT organisation scoped, also deliberately. The sync fetches every shipment
 * the Hub knows about, and a French user refreshing must not blank the American
 * rows. Scope belongs on the READ, which is where loadCargoBoard applies it.
 */
export async function syncCargo(): Promise<{ ok: true; result: CargoSyncResult } | { ok: false; error: string }> {
  const auth = await getAuthorizedUser()
  if (!auth.ok || !auth.capabilities.has('transport.view')) {
    return { ok: false, error: 'You do not have access to transport.' }
  }

  try {
    const result = await syncAllCargo()
    revalidatePath('/transport')
    return { ok: true, result }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Could not reach Cargo Partner.' }
  }
}
