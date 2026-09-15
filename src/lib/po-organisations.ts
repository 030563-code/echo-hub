import 'server-only'

import type { SupabaseClient } from '@supabase/supabase-js'
import { createAdminClient } from '@/lib/supabase/admin'
import { chainTouchesOrgs, partiesForOrg, type OrgCode } from '@/lib/organisations'

/**
 * Which purchase-order chains belong to which organisation.
 *
 * A chain runs Depot to Group to s.r.o. to Bamida, and every leg names two
 * parties (from_entity, to_entity): a company code or a depot code. A chain is
 * an organisation's when ANY leg names the company or one of its depots, and
 * the organisation then sees the chain WHOLE: a USA order's Group and s.r.o.
 * legs are still that order. So USA sees the chains its depots raised, Group
 * sees every Hub chain (each one runs through EB-GROUP), s.r.o. sees the ones
 * that have reached it.
 */

type LegParties = { id: string; master_ref: string | null; from_entity: string | null; to_entity: string | null }

const LEG_COLUMNS = 'id, master_ref, from_entity, to_entity'

/**
 * Is this purchase order's chain one of the caller's organisations'?
 *
 * The one question every purchase-order action asks after its capability
 * check. Read with the service role: it is a yes or no about parties, never a
 * row handed back, and the action itself reads the order under RLS as before.
 * An unknown id is a no.
 */
export async function poChainHeldBy(poId: string, held: readonly OrgCode[]): Promise<boolean> {
  if (held.length === 0) return false
  const admin = createAdminClient()
  const { data: po } = await admin.from('purchase_orders').select(LEG_COLUMNS).eq('id', poId).maybeSingle<LegParties>()
  if (!po) return false

  let legs: LegParties[] = [po]
  if (po.master_ref) {
    const { data } = await admin.from('purchase_orders').select(LEG_COLUMNS).eq('master_ref', po.master_ref)
    if (data && data.length > 0) legs = data as LegParties[]
  }
  return chainTouchesOrgs(legs, held)
}

/** PostgREST `or` filter: legs where either party is one of `parties`. */
export function partyFilter(parties: readonly string[]): string {
  const list = parties.map((p) => `"${p}"`).join(',')
  return `from_entity.in.(${list}),to_entity.in.(${list})`
}

export interface OrgChains {
  /** master_ref of every chain with a leg touching the organisation. */
  refs: string[]
  /** Legs touching it that carry no master_ref (older rows), by id. */
  ids: string[]
}

/**
 * The chains touching the organisation, found through the legs that name it.
 * Read with the caller's own client, so RLS applies exactly as it does to the
 * board that follows.
 */
export async function chainsForOrg(client: SupabaseClient, org: OrgCode): Promise<OrgChains> {
  const { data } = await client
    .from('purchase_orders')
    .select('id, master_ref')
    .or(partyFilter(partiesForOrg(org)))
    .neq('status', 'cancelled')
  const refs = new Set<string>()
  const ids: string[] = []
  for (const row of (data ?? []) as { id: string; master_ref: string | null }[]) {
    if (row.master_ref) refs.add(String(row.master_ref))
    else ids.push(String(row.id))
  }
  return { refs: [...refs], ids }
}

/** The `or` filter that loads those chains whole, or null when there are none
 *  and the caller should query nothing at all. */
export function chainFilter(chains: OrgChains): string | null {
  const parts: string[] = []
  if (chains.refs.length > 0) parts.push(`master_ref.in.(${chains.refs.map((r) => `"${r}"`).join(',')})`)
  if (chains.ids.length > 0) parts.push(`id.in.(${chains.ids.map((i) => `"${i}"`).join(',')})`)
  return parts.length > 0 ? parts.join(',') : null
}
