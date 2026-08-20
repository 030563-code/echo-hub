'use server'

import { createServerClient } from '@/lib/supabase/server'

export async function getMappedSkus(
  depotCode?: string | string[]
): Promise<{ success: boolean; data?: string[]; error?: string }> {
  const supabase = await createServerClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { success: false, error: 'Unauthorized' }

  let query = supabase
    .from('product_depot_mapping')
    .select('hubspot_sku_code')
    .eq('is_active', true)

  // A rep who hasn't picked a depot yet still needs the picker restricted to
  // the union of THEIR depots — unrestricted would surface every mapped SKU,
  // including EB-SRO's manufacturing-only codes.
  if (Array.isArray(depotCode)) {
    // An empty list means the caller has NO depots — that is zero SKUs, not
    // "no restriction": falling through unfiltered would hand every mapped
    // code (EB-SRO's included) to the browser.
    if (depotCode.length === 0) return { success: true, data: [] }
    query = query.in('depot_code', depotCode)
  } else if (depotCode) {
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
