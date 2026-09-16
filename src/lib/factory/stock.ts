import 'server-only'

/**
 * The manufacturer's own material stock, as their system last reported it.
 *
 * Read with the CALLER'S client, not the service role, on purpose. This feed is
 * the one thing the new policy grants a factory account, so if that policy is
 * ever wrong this page goes empty and somebody notices. Reading it as the
 * service role would paper over exactly the mistake worth catching.
 *
 * NEVER available_quantity, NEVER reserved. They are quantity minus
 * reservations that their system accumulates and never drains, so ten of the
 * 112 cards read deeply negative (orange thread at -165,717 m against 75,093 m
 * physically on the shelf). The column comment in the 2026-08-08 migration says
 * the same. quantity is the number that means something.
 */

import { createServerClient } from '@/lib/supabase/server'

export interface FactoryStockRow {
  ns_number: string
  item_name: string
  quantity: number | null
  unit: string | null
  availability: string | null
  last_synced_at: string
}

export async function loadFactoryStock(): Promise<{
  rows: FactoryStockRow[]
  newestSyncAt: string | null
}> {
  const supabase = await createServerClient()
  const { data, error } = await supabase
    .from('bamida_material_stock')
    .select('ns_number, item_name, quantity, unit, availability, last_synced_at')
    .eq('is_active', true)
    .order('item_name')

  if (error) {
    console.error('loadFactoryStock failed', error.message)
    return { rows: [], newestSyncAt: null }
  }

  const rows = (data ?? []) as FactoryStockRow[]
  const newestSyncAt = rows.reduce<string | null>(
    (newest, row) => (newest === null || row.last_synced_at > newest ? row.last_synced_at : newest),
    null,
  )
  return { rows, newestSyncAt }
}
