import 'server-only'

import { createServerClient } from '@/lib/supabase/server'
import type { ItemCatalogEntry, PoSupplier } from '@/lib/erp-types'

const SUPPLIER_COLS =
  'id, code, name, city, country, currency, address, tax_number, xero_contact_id, active'

/** Active suppliers (picklist), ordered by name. RLS: any authenticated user may read. */
export async function loadActiveSuppliers(): Promise<PoSupplier[]> {
  const supabase = await createServerClient()
  const { data } = await supabase
    .from('po_suppliers')
    .select(SUPPLIER_COLS)
    .eq('active', true)
    .order('name')
  return (data ?? []) as PoSupplier[]
}

/** A single supplier by its catalogue code (active or not), or null. */
export async function getSupplierByCode(code: string): Promise<PoSupplier | null> {
  const supabase = await createServerClient()
  const { data } = await supabase
    .from('po_suppliers')
    .select(SUPPLIER_COLS)
    .eq('code', code)
    .maybeSingle()
  return (data as PoSupplier | null) ?? null
}

/** Active item-catalogue entries (picklist), optionally filtered to one product_group. */
export async function loadItemCatalog(group?: string): Promise<ItemCatalogEntry[]> {
  const supabase = await createServerClient()
  let query = supabase
    .from('item_catalog')
    .select('code, description, product_group, base_unit, currency, active')
    .eq('active', true)
  if (group) query = query.eq('product_group', group)
  const { data } = await query.order('code')
  return (data ?? []) as ItemCatalogEntry[]
}
