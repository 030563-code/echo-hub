'use server'

import { createServerClient } from '@/lib/supabase/server'
import { hasAnyCapability } from '@/lib/authz'

export interface SkuPriceStat {
  sampleCount: number
  medianPrice: number
}

/**
 * Typical prices per SKU from the caller's own visible quote history
 * (region-scoped by deals_registry RLS — the RPC is SECURITY INVOKER).
 *
 * Exists because the HubSpot product library carries $1 placeholder prices on
 * the NA products, so "what does an H9 usually go for" is only answerable
 * from what was actually quoted. SKUs with fewer than 5 samples are omitted.
 */
export async function getSkuPriceStats(
  skus: string[]
): Promise<{ success: boolean; data?: Record<string, SkuPriceStat>; error?: string }> {
  const supabase = await createServerClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { success: false, error: 'Unauthorized' }
  if (!(await hasAnyCapability(['quotes.view', 'quotes.create']))) {
    return { success: false, error: 'Forbidden: missing quotes capability' }
  }

  const cleaned = Array.from(
    new Set(skus.map((s) => (s ?? '').toString().trim()).filter(Boolean))
  ).slice(0, 200)
  if (cleaned.length === 0) return { success: true, data: {} }

  const { data, error } = await supabase.rpc('get_sku_price_stats', { p_skus: cleaned })
  if (error) {
    console.error('get_sku_price_stats failed:', error.message)
    return { success: false, error: 'Could not load typical prices.' }
  }

  const stats: Record<string, SkuPriceStat> = {}
  for (const row of (data ?? []) as { sku: string; sample_count: number; median_price: number }[]) {
    stats[row.sku] = {
      sampleCount: Number(row.sample_count),
      medianPrice: Number(row.median_price),
    }
  }
  return { success: true, data: stats }
}
