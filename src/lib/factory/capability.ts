import 'server-only'

/**
 * The factory's product table: what they can build against what we will need.
 *
 * Read with the CALLER'S client, like the material feed, on purpose. The four
 * MRP tables behind this opened to the factory account on 18 Sep 2026 and if
 * one of those policies is ever wrong this table goes empty and somebody
 * notices, rather than the service role papering over it.
 *
 * 🔴 The nightly row is read for ONE column, action_qty. Our depot stock, what
 * is in transit, what is on order, firm orders and the weighted quote pipeline
 * are not selected here, so they cannot reach a factory screen even by
 * accident. See the header of capability-math.ts.
 *
 * The arithmetic is in capability-math.ts. This is only the reads.
 */

import { createServerClient } from '@/lib/supabase/server'
import type { BomComponentRow } from '@/lib/mrp/materials'
import {
  materialNeeds,
  productCapabilities,
  type CapabilityStatusRow,
  type FactoryBomProduct,
  type FactoryProductCapability,
  type MaterialNeed,
  type SkuMapRow,
} from './capability-math'

export interface FactoryCapability {
  products: FactoryProductCapability[]
  /** Keyed on the material's code, the same key as the stock rows. */
  needs: Map<string, MaterialNeed>
  /** Every material line of every product, for the per-product breakdown. */
  components: BomComponentRow[]
  /** The engine run the requirement comes from, or null when there has been none. */
  runDate: string | null
}

const EMPTY: FactoryCapability = { products: [], needs: new Map(), components: [], runDate: null }

/**
 * `stock` is the feed the page has already read, so the material quantities
 * come from one read and the two tables cannot disagree.
 */
export async function loadFactoryCapability(
  stock: readonly { ns_number: string; quantity: number | null }[],
): Promise<FactoryCapability> {
  const supabase = await createServerClient()

  const [{ data: productRows, error: productError }, { data: componentRows }, { data: mapRows }] =
    await Promise.all([
      supabase.from('mrp_bom_product').select('fg_code, fg_label, pallet_size'),
      supabase
        .from('mrp_bom_component')
        .select('fg_code, component_code, component_desc, qty, basis, line_type, is_gating'),
      supabase.from('mrp_bom_sku_map').select('hub_sku, fg_code, confirmed'),
    ])

  if (productError) {
    console.error('loadFactoryCapability: bom products', productError.message)
    return EMPTY
  }
  const products = (productRows ?? []) as FactoryBomProduct[]
  if (products.length === 0) return EMPTY
  const components = (componentRows ?? []) as BomComponentRow[]
  const skuMap = (mapRows ?? []) as SkuMapRow[]
  const hubSkus = skuMap.map((m) => m.hub_sku)

  // The requirement is only for the products we sell, so a run and a catalogue
  // name are both optional: without them a product still shows its ceiling.
  let status: CapabilityStatusRow[] = []
  let runDate: string | null = null
  const names = new Map<string, string>()

  if (hubSkus.length > 0) {
    const { data: latest } = await supabase
      .from('mrp_buffer_status_daily')
      .select('run_date')
      .in('sku', hubSkus)
      .order('run_date', { ascending: false })
      .limit(1)
      .maybeSingle<{ run_date: string }>()
    runDate = latest?.run_date ?? null

    const [{ data: statusRows }, { data: catalog }] = await Promise.all([
      runDate
        ? supabase
            .from('mrp_buffer_status_daily')
            .select('sku, run_date, action_qty, flags')
            .eq('run_date', runDate)
            .in('sku', hubSkus)
        : Promise.resolve({ data: [] }),
      supabase.from('po_product_catalog').select('sku, product_name').in('sku', hubSkus),
    ])
    status = (statusRows ?? []) as unknown as CapabilityStatusRow[]
    for (const c of (catalog ?? []) as { sku: string; product_name: string | null }[]) {
      if (c.product_name) names.set(c.sku, c.product_name)
    }
  }

  const stockByCode = new Map<string, number>()
  for (const s of stock) stockByCode.set(s.ns_number, Math.max(0, Number(s.quantity ?? 0)))

  const built = productCapabilities({ products, components, stockByCode, skuMap, status, names })
  return { products: built, needs: materialNeeds(built, components, stockByCode), components, runDate }
}
