import 'server-only'

import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * The depot allow-list check on quoted SKUs.
 *
 * A rep may only quote products their own depots actually carry. Without this,
 * EB-SRO's manufacturing codes and the other regions' catalogues are quotable
 * by anyone, which is a cross-region data and pricing leak rather than a typo.
 *
 * Lives here because BOTH creating a quote and editing a published one have to
 * apply it. An edit can add a line the original quote never had, so checking it
 * only on create would leave the exact same hole one click further along.
 *
 * A SKU that is in no depot mapping at all is deliberately allowed through:
 * that is the manual-price case the builder exists to support, and blocking it
 * would make unmapped products unquotable. Only a SKU that IS mapped, to
 * somebody else's depot, is refused.
 */

/**
 * Any Supabase client, session or admin.
 *
 * Deliberately the un-parameterised SupabaseClient rather than a hand-written
 * structural type: describing `.from().select().eq().in()` by hand makes
 * TypeScript try to reconcile it with the real generated query builder and it
 * gives up with "type instantiation is excessively deep".
 */
type DepotMappingClient = SupabaseClient

export type SkuScopeResult =
  | { ok: true; wrongDepot: [] }
  | { ok: true; wrongDepot: string[] }
  | { ok: false; error: string }

/**
 * The quoted SKUs that belong to a depot outside `depotScope`.
 *
 * Returns ok:false only when the mapping could not be read, which must fail the
 * quote rather than silently allow everything.
 */
export async function findOutOfScopeSkus(
  supabase: DepotMappingClient,
  quotedSkus: readonly string[],
  depotScope: readonly string[],
): Promise<SkuScopeResult> {
  const skus = Array.from(new Set(quotedSkus.map((s) => String(s ?? '').trim()).filter(Boolean)))
  if (skus.length === 0) return { ok: true, wrongDepot: [] }

  const { data: mapRows, error } = await supabase
    .from('product_depot_mapping')
    .select('hubspot_sku_code, depot_code')
    .eq('is_active', true)
    .in('hubspot_sku_code', skus)

  if (error) {
    console.error('product_depot_mapping lookup failed:', error.message)
    return { ok: false, error: 'Could not verify products for this depot. Please try again.' }
  }

  const rows = mapRows ?? []
  const mappedAnywhere = new Set(rows.map((r) => r.hubspot_sku_code))
  const allowedHere = new Set(
    rows.filter((r) => depotScope.includes(r.depot_code)).map((r) => r.hubspot_sku_code),
  )

  return { ok: true, wrongDepot: skus.filter((s) => mappedAnywhere.has(s) && !allowedHere.has(s)) }
}
