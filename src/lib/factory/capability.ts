import 'server-only'

/**
 * The factory's product table: what they can build against what we will need.
 *
 * Read with the CALLER'S client, like the material feed, on purpose. The four
 * MRP tables behind this opened to the factory account on 18 Sep 2026 and if
 * one of those policies is ever wrong this table goes empty and somebody
 * notices, rather than the service role papering over it. The status table is
 * row-limited to the SKUs that have a bill of materials, so a supplier reads
 * the products they build and nothing else.
 *
 * The arithmetic is in capability-math.ts. This is only the reads.
 */

import { createServerClient } from '@/lib/supabase/server'
import type { BomComponentRow, BomProductRow } from '@/lib/mrp/materials'
import {
  materialNeeds,
  productCapabilities,
  type CapabilityStatusRow,
  type FactoryProductCapability,
  type MaterialNeed,
  type SkuMapRow,
} from './capability-math'

export interface FactoryCapability {
  products: FactoryProductCapability[]
  /** Keyed on the material's code, the same key as the stock rows. */
  needs: Map<string, MaterialNeed>
  /** The engine run the figures come from, or null when there has been none. */
  runDate: string | null
}

const EMPTY: FactoryCapability = { products: [], needs: new Map(), runDate: null }

const STATUS_COLUMNS =
  'sku, run_date, max_buildable, materials_binding_code, materials_binding_desc, action_qty, ' +
  'firm_demand, qualified_spikes, on_hand, in_transit, on_order, flags'

/**
 * `stock` is the feed the page has already read, so the material quantities
 * come from one read and the two tables cannot disagree.
 */
export async function loadFactoryCapability(
  stock: readonly { ns_number: string; quantity: number | null }[],
): Promise<FactoryCapability> {
  const supabase = await createServerClient()

  const { data: mapRows, error: mapError } = await supabase
    .from('mrp_bom_sku_map')
    .select('hub_sku, fg_code, confirmed')
  if (mapError) {
    console.error('loadFactoryCapability: sku map', mapError.message)
    return EMPTY
  }
  const skuMap = (mapRows ?? []) as SkuMapRow[]
  if (skuMap.length === 0) return EMPTY
  const hubSkus = skuMap.map((m) => m.hub_sku)
  const fgCodes = Array.from(new Set(skuMap.map((m) => m.fg_code)))

  const { data: latest } = await supabase
    .from('mrp_buffer_status_daily')
    .select('run_date')
    .in('sku', hubSkus)
    .order('run_date', { ascending: false })
    .limit(1)
    .maybeSingle<{ run_date: string }>()
  if (!latest?.run_date) return EMPTY

  const [{ data: statusRows }, { data: bomProducts }, { data: components }, { data: catalog }] =
    await Promise.all([
      supabase
        .from('mrp_buffer_status_daily')
        .select(STATUS_COLUMNS)
        .eq('run_date', latest.run_date)
        .in('sku', hubSkus),
      supabase.from('mrp_bom_product').select('fg_code, pallet_size').in('fg_code', fgCodes),
      supabase
        .from('mrp_bom_component')
        .select('fg_code, component_code, component_desc, qty, basis, line_type, is_gating')
        .in('fg_code', fgCodes),
      supabase.from('po_product_catalog').select('sku, product_name').in('sku', hubSkus),
    ])

  const names = new Map<string, string>()
  for (const c of (catalog ?? []) as { sku: string; product_name: string | null }[]) {
    if (c.product_name) names.set(c.sku, c.product_name)
  }

  const products = productCapabilities(
    (statusRows ?? []) as unknown as CapabilityStatusRow[],
    skuMap,
    names,
  )
  const stockByCode = new Map<string, number>()
  for (const s of stock) stockByCode.set(s.ns_number, Math.max(0, Number(s.quantity ?? 0)))
  const needs = materialNeeds(
    products,
    skuMap,
    (bomProducts ?? []) as BomProductRow[],
    (components ?? []) as BomComponentRow[],
    stockByCode,
  )
  return { products, needs, runDate: latest.run_date }
}
