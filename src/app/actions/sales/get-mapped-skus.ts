'use server'

import { createServerClient } from '@/lib/supabase/server'

export async function getMappedSkus(depotCode?: string): Promise<{ success: boolean; data?: string[]; error?: string }> {
  const supabase = await createServerClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { success: false, error: 'Unauthorized' }

  let query = supabase
    .from('product_depot_mapping')
    .select('hubspot_sku_code')
    .eq('is_active', true)

  if (depotCode) {
    query = query.eq('depot_code', depotCode)
  }

  const { data, error } = await query

  if (error) {
    console.error('Error fetching mapped SKUs:', error)
    return { success: false, error: error.message }
  }

  // Return unique SKUs
  const skus = data.map(item => item.hubspot_sku_code)
  const mappedSkus = Array.from(new Set(skus))
  return { success: true, data: mappedSkus }
}
