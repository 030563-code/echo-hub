'use server'

/**
 * The stock board's writes: a physical count, and a manual adjustment.
 *
 * Both are stock.edit. Both mint nothing themselves: the client supplies the
 * batch or ref id once per dialog open, so a double click or a retry after a
 * timeout reaches the ledger with the same key and applies nothing twice.
 * Validation is at this boundary; the RPCs validate again for the row shape.
 */

import { z } from 'zod'
import { revalidatePath } from 'next/cache'
import { getAuthorizedUser } from '@/lib/authz'
import { createAdminClient } from '@/lib/supabase/admin'
import { applyStockMovements, recordStockCount, type CountOutcome } from '@/lib/stock/apply'
import { STOCK_WAREHOUSES } from '@/lib/stock/warehouses'
import { loadMovements, type MovementRow } from '@/lib/stock/board-data'

const Warehouse = z.enum(STOCK_WAREHOUSES)
const ItemKind = z.enum(['finished', 'material'])
const Sku = z.string().trim().min(1).max(60).regex(/^[A-Z0-9][A-Z0-9._-]*$/i, 'Not a SKU or component code')

const CountInput = z.object({
  itemKind: ItemKind,
  warehouse: Warehouse,
  batchId: z.string().uuid(),
  note: z.string().trim().max(300).optional(),
  rows: z
    .array(z.object({ sku: Sku, counted: z.number().min(0).max(1_000_000_000) }))
    .min(1, 'Nothing to record')
    .max(500, 'Record at most 500 lines at a time'),
})

const AdjustInput = z.object({
  itemKind: ItemKind,
  warehouse: Warehouse,
  sku: Sku,
  delta: z.number().refine((n) => n !== 0, 'A zero adjustment changes nothing'),
  note: z.string().trim().min(5, 'Say why, in at least a few words').max(300),
  refId: z.string().uuid(),
})

export type StockWriteResult<T> = { success: true; data: T } | { success: false; error: string }

async function gate() {
  const auth = await getAuthorizedUser()
  if (!auth.ok) return { ok: false as const, error: auth.error }
  if (!auth.capabilities.has('stock.edit')) {
    return { ok: false as const, error: 'Forbidden: you need stock.edit to change stock' }
  }
  return { ok: true as const, uid: auth.user.id }
}

export async function recordStockCountAction(input: unknown): Promise<StockWriteResult<CountOutcome[]>> {
  const g = await gate()
  if (!g.ok) return { success: false, error: g.error }
  const parsed = CountInput.safeParse(input)
  if (!parsed.success) return { success: false, error: parsed.error.issues[0]?.message ?? 'Invalid input' }
  const { itemKind, warehouse, batchId, note, rows } = parsed.data

  if (itemKind === 'finished' && rows.some((r) => !Number.isInteger(r.counted))) {
    return { success: false, error: 'Finished goods are counted in whole units' }
  }

  const result = await recordStockCount(
    createAdminClient(),
    itemKind,
    warehouse,
    rows.map((r) => ({ sku: r.sku.toUpperCase(), counted: r.counted })),
    batchId,
    g.uid,
    note && note !== '' ? note : 'Physical count recorded on the stock board',
  )
  if (!result.ok) return { success: false, error: result.error }
  revalidatePath('/stock', 'layout')
  return { success: true, data: result.rows }
}

export async function recordStockAdjustmentAction(
  input: unknown,
): Promise<StockWriteResult<{ applied: number; skipped: number }>> {
  const g = await gate()
  if (!g.ok) return { success: false, error: g.error }
  const parsed = AdjustInput.safeParse(input)
  if (!parsed.success) return { success: false, error: parsed.error.issues[0]?.message ?? 'Invalid input' }
  const { itemKind, warehouse, sku, delta, note, refId } = parsed.data

  if (itemKind === 'finished' && !Number.isInteger(delta)) {
    return { success: false, error: 'Finished goods move in whole units' }
  }

  const result = await applyStockMovements(
    createAdminClient(),
    [
      {
        item_kind: itemKind,
        warehouse_code: warehouse,
        sku: sku.toUpperCase(),
        kind: 'adjustment',
        quantity: delta,
        ref_type: 'adjustment',
        ref_id: refId,
        note,
      },
    ],
    g.uid,
  )
  if (!result.ok) return { success: false, error: result.error }
  revalidatePath('/stock', 'layout')
  return { success: true, data: { applied: result.applied, skipped: result.skipped } }
}

const MovementsInput = z.object({
  itemKind: ItemKind,
  warehouse: Warehouse,
  sku: Sku,
})

/** The movements behind one row, for the side panel. Read: stock.view or stock.edit. */
export async function loadRowMovements(input: unknown): Promise<StockWriteResult<MovementRow[]>> {
  const auth = await getAuthorizedUser()
  if (!auth.ok) return { success: false, error: auth.error }
  if (!auth.capabilities.has('stock.view') && !auth.capabilities.has('stock.edit')) {
    return { success: false, error: 'Forbidden: you need stock.view' }
  }
  const parsed = MovementsInput.safeParse(input)
  if (!parsed.success) return { success: false, error: 'Invalid input' }
  const { itemKind, warehouse, sku } = parsed.data
  const rows = await loadMovements({ itemKind, warehouse, sku: sku.toUpperCase(), limit: 50 })
  return { success: true, data: rows }
}
