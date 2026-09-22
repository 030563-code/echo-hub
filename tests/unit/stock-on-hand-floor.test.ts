import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * On hand is never negative.
 *
 * Dean, 22 Sep 2026: "we can never have negative values for materials in the
 * stock levels for both finished products and materials. That being said all
 * on hand values should have a minimum value of 0."
 *
 * Three layers, each pinned here: the writers floor at zero, the tables carry
 * a CHECK, and every screen clamps what it reads. Same genre as
 * stock-schema-coherence.test.ts: the SQL and the TypeScript must agree.
 */

const read = (path: string) => readFileSync(join(process.cwd(), path), 'utf8')
const UP = 'supabase/migrations/20260922110000_stock_on_hand_floor.sql'
const DOWN = 'supabase/migrations/rollback/20260922110000_stock_on_hand_floor.down.sql'
const up = read(UP)
const down = read(DOWN)

const WRITERS = [
  'hub_apply_stock_movements',
  'hub_sync_xero_stock_to_warehouse',
  'apply_manufacturing_stocktake',
  'decrement_stock',
]

/** The body of one function definition in a file, or '' when it is not there. */
function body(sql: string, fn: string): string {
  const re = new RegExp(`create or replace function public\\.${fn}\\([\\s\\S]*?\\$(?:\\$|function\\$);`, 'i')
  return sql.match(re)?.[0] ?? ''
}

describe('the migration', () => {
  it('redefines every writer that could take a balance below zero, each with a floor', () => {
    for (const fn of WRITERS) {
      const b = body(up, fn)
      expect(b, `${fn} not redefined`).not.toBe('')
      expect(b, `${fn} has no floor`).toContain('greatest(0')
    }
  })

  it('keeps the true signed quantity on a floored movement and says what the balance would have been', () => {
    const b = body(up, 'hub_apply_stock_movements')
    expect(b).toContain('v_after := greatest(0, v_bal + v_qty)')
    expect(b).toContain('(v_item, v_wh, v_sku, v_kind, v_qty, v_after,')
    expect(b).toContain("format('Balance floored at 0; without the floor it would be %s.', v_bal + v_qty)")
    expect(b).toContain('set quantity_on_hand = v_after::integer')
    expect(b).toContain('set quantity = v_after')
  })

  it('floors the rows that are negative today through the ledger, never by a bare update', () => {
    // Both tables: one adjustment movement per negative row, then the level to zero.
    for (const kind of ["'material'", "'finished'"]) {
      expect(up).toMatch(new RegExp(`select ${kind}, l\\.warehouse_code, l\\.[a-z_]+, 'adjustment', -l\\.[a-z_]+, 0,\\s+'floor', '20260922110000', false`))
    }
    expect(up).toMatch(/update public\.material_stock_levels\s+set quantity = 0, updated_at = now\(\)\s+where quantity < 0/)
    expect(up).toMatch(/update public\.warehouse_stock_levels\s+set quantity_on_hand = 0, updated_at = now\(\)\s+where quantity_on_hand < 0/)
    // The ledger's dedupe index, so a re-run adds nothing.
    expect((up.match(/on conflict \(kind, ref_type, ref_id, warehouse_code, sku\) do nothing/g) ?? []).length).toBeGreaterThanOrEqual(3)
  })

  it('adds the CHECK on both level tables after the rows are floored', () => {
    const material = up.indexOf('add constraint material_stock_levels_quantity_not_negative check (quantity >= 0)')
    const finished = up.indexOf('add constraint warehouse_stock_levels_on_hand_not_negative check (quantity_on_hand >= 0)')
    const floor = up.indexOf("'floor', '20260922110000'")
    expect(material).toBeGreaterThan(floor)
    expect(finished).toBeGreaterThan(floor)
  })

  it('has a rollback that drops both CHECKs, restores the four writers and keeps the adjustments', () => {
    expect(down).toContain('drop constraint if exists warehouse_stock_levels_on_hand_not_negative')
    expect(down).toContain('drop constraint if exists material_stock_levels_quantity_not_negative')
    for (const fn of WRITERS) {
      const b = body(down, fn)
      expect(b, `${fn} not restored`).not.toBe('')
      expect(b, `${fn} restored WITH a floor`).not.toContain('greatest(0')
    }
    expect(down).not.toMatch(/delete from public\.stock_movements/)
  })
})

describe('the screens and the engine clamp what they read', () => {
  it.each([
    ['src/lib/stock/positions.ts', 'row.on_hand = Math.max(0, Math.trunc(Number(l.quantity_on_hand) || 0))'],
    ['src/lib/stock/board-data.ts', 'quantity_on_hand: Math.max(0, Number(l.quantity_on_hand ?? 0))'],
    ['src/lib/stock/board-data.ts', 'const onHand = Math.max(0, Number(l.quantity ?? 0))'],
    ['src/lib/stock/board-data.ts', 'bamida_quantity: card ? Math.max(0, card.quantity) : null'],
    ['src/app/(dashboard)/factory/stock/factory-stock-table.tsx', '{Math.max(0, row.original.quantity ?? 0)}'],
    ['src/app/(dashboard)/factory/stock/[fg]/page.tsx', 'Math.max(0, Number(r.quantity ?? 0))'],
    ['src/lib/factory/capability.ts', 'Math.max(0, Number(s.quantity ?? 0))'],
    ['src/lib/mrp/legacy-aggregates.ts', 'Math.max(0, row.quantity_on_hand ?? 0)'],
  ])('%s', (file, needle) => {
    expect(read(file)).toContain(needle)
  })
})

describe('the floor is a floor, never a gate', () => {
  // Dean, 22 Sep 2026: "they should still be able to continue with a purchase
  // order even though theres no stock level ... Sometimes they get stock from
  // supplier and the system is just not in sync." So a movement that would
  // take a balance below zero is recorded and floored, never refused, and no
  // order step asks the balance table for permission.
  it('the ledger writer records a short movement rather than raising', () => {
    const b = body(up, 'hub_apply_stock_movements')
    expect(b).toContain('v_after := greatest(0, v_bal + v_qty)')
    // The function's own name carries the word stock; only refusal wording counts.
    expect(b).not.toMatch(/raise exception[^;]*(not enough|insufficient|below zero|go negative|on hand)/i)
  })

  it('fulfilling from stock and raising an order never read the balance to say no', () => {
    for (const file of [
      'src/app/actions/purchase-orders/fulfil-from-stock.ts',
      'src/app/actions/purchase-orders/create-po.ts',
      'src/app/actions/purchase-orders/receive-po.ts',
    ]) {
      const src = read(file)
      expect(src, `${file} reads the balance`).not.toContain('quantity_on_hand')
      expect(src, `${file} refuses on stock`).not.toMatch(/insufficient|not enough stock|out of stock/i)
    }
  })
})
