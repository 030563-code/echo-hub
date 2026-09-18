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
  /** When the sync last ran. */
  last_synced_at: string
  /** When the figures last actually moved. The stamp that means something. */
  last_changed_at: string | null
}

export async function loadFactoryStock(): Promise<{
  rows: FactoryStockRow[]
  newestSyncAt: string | null
  /** The most recent change anywhere in the feed, or null when it has none. */
  newestChangeAt: string | null
}> {
  const supabase = await createServerClient()
  const { data, error } = await supabase
    .from('bamida_material_stock')
    .select('ns_number, item_name, quantity, unit, availability, last_synced_at, last_changed_at')
    .eq('is_active', true)
    .order('item_name')

  if (error) {
    console.error('loadFactoryStock failed', error.message)
    return { rows: [], newestSyncAt: null, newestChangeAt: null }
  }

  const rows = (data ?? []) as FactoryStockRow[]
  const newest = (pick: (row: FactoryStockRow) => string | null) =>
    rows.reduce<string | null>((acc, row) => {
      const v = pick(row)
      return v && (acc === null || v > acc) ? v : acc
    }, null)
  return {
    rows,
    newestSyncAt: newest((r) => r.last_synced_at),
    newestChangeAt: newest((r) => r.last_changed_at),
  }
}
