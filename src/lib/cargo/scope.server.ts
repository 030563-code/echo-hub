import 'server-only'

import { getAuthorizedUser } from '@/lib/authz'
import { createAdminClient } from '@/lib/supabase/admin'
import { depotsForOrgs, transportSeesAllFor, type OrgCode } from '@/lib/organisations'

/**
 * Who may act on which shipment, for every Transport action.
 *
 * Kept out of the 'use server' files on purpose: every export of one of those is a public
 * endpoint, and these two are checks, not actions.
 */

/** The depots the caller may act on, or null when they see every shipment. */
export async function transportScope(): Promise<
  { ok: true; depots: readonly string[] | null; uid: string } | { ok: false; error: string }
> {
  const auth = await getAuthorizedUser()
  if (!auth.ok || !auth.capabilities.has('transport.view')) {
    return { ok: false, error: 'You do not have access to transport.' }
  }
  const held = auth.profile.organisations as OrgCode[]
  // Every container leaves s.r.o. and belongs to Group on the way, so those two
  // see all of them; anyone else sees what is bound for their own depots.
  return {
    ok: true,
    depots: transportSeesAllFor(held) ? null : depotsForOrgs(held),
    uid: auth.user.id,
  }
}

export async function shipmentInScope(spotId: string, depots: readonly string[] | null): Promise<boolean> {
  const admin = createAdminClient()
  const { data } = await admin.from('cargo_shipment').select('destination_depot').eq('spot_id', spotId).maybeSingle()
  if (!data) return false
  if (!depots) return true
  const depot = (data as { destination_depot: string | null }).destination_depot
  return Boolean(depot && depots.includes(depot))
}

/**
 * Whether a SPOT is on the board only because somebody added it by hand, which is when it can be
 * taken back off (cargo_remove_hand_added_spot decides the rest, under its lock).
 */
export async function isHandAddedSpot(spotId: string): Promise<boolean> {
  const { data } = await createAdminClient().from('cargo_tracked_spot').select('spot_id').eq('spot_id', spotId).maybeSingle()
  return Boolean(data)
}
