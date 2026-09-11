import 'server-only'

/**
 * The one door into the stock ledger from TypeScript.
 *
 * Every balance change goes through hub_apply_stock_movements or
 * hub_record_stock_count, both service-role RPCs, and this is the only module
 * allowed to name them (tests/unit/stock-write-guard.test.ts fails the build
 * otherwise). Callers are best-effort by convention: the business write that
 * caused the movement has already happened, so a ledger failure is logged by
 * the caller and never thrown back at the person who pressed the button.
 * That stance is recordReceipt's, kept unchanged.
 */

import type { createAdminClient } from '@/lib/supabase/admin'
import type { ItemKind, StockMovementInput } from '@/lib/stock/movements'

type Admin = ReturnType<typeof createAdminClient>

export type ApplyMovementsResult =
  | { ok: true; applied: number; skipped: number }
  | { ok: false; error: string }

export async function applyStockMovements(
  admin: Admin,
  rows: readonly StockMovementInput[],
  uid: string | null,
): Promise<ApplyMovementsResult> {
  if (rows.length === 0) return { ok: true, applied: 0, skipped: 0 }
  const { data, error } = await admin.rpc('hub_apply_stock_movements', {
    p_rows: rows,
    p_uid: uid,
  })
  if (error) return { ok: false, error: error.message }
  const out = (data ?? {}) as { applied?: number; skipped?: number }
  return { ok: true, applied: Number(out.applied ?? 0), skipped: Number(out.skipped ?? 0) }
}

export interface CountInputRow {
  sku: string
  counted: number
  product_name?: string | null
  description?: string | null
  unit?: string | null
}

export interface CountOutcome {
  sku: string
  before: number
  counted: number
  delta: number
  applied: boolean
}

export type RecordCountResult = { ok: true; rows: CountOutcome[] } | { ok: false; error: string }

/**
 * Record a physical count. `batchId` is the idempotency key for the whole
 * batch: the caller mints it once (per dialog open, per script run), so a
 * retry applies nothing twice and still stamps the count date.
 */
export async function recordStockCount(
  admin: Admin,
  itemKind: ItemKind,
  warehouse: string,
  rows: readonly CountInputRow[],
  batchId: string,
  uid: string | null,
  note: string | null,
): Promise<RecordCountResult> {
  if (rows.length === 0) return { ok: true, rows: [] }
  const { data, error } = await admin.rpc('hub_record_stock_count', {
    p_item_kind: itemKind,
    p_warehouse: warehouse,
    p_rows: rows,
    p_batch_id: batchId,
    p_uid: uid,
    p_note: note,
  })
  if (error) return { ok: false, error: error.message }
  const out = Array.isArray(data) ? (data as Array<Record<string, unknown>>) : []
  return {
    ok: true,
    rows: out.map((r) => ({
      sku: String(r.sku ?? ''),
      before: Number(r.before ?? 0),
      counted: Number(r.counted ?? 0),
      delta: Number(r.delta ?? 0),
      applied: r.applied === true,
    })),
  }
}
