import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { MOVEMENT_KINDS } from '@/lib/stock/movements'

/**
 * The ledger migration and the TypeScript that speaks to it must agree.
 *
 * Same genre as page-state-key.test.ts: read the migration file and pin the
 * parts the code relies on, so a CHECK list edited in SQL without the TS union
 * (or the other way round) fails here and not in front of a person.
 */

const MIG = 'supabase/migrations/20260911120000_stock_ledger.sql'
const DOWN = 'supabase/migrations/rollback/20260911120000_stock_ledger.down.sql'
const up = readFileSync(join(process.cwd(), MIG), 'utf8')

describe('stock ledger migration', () => {
  it('lists exactly the movement kinds the code knows', () => {
    const m = up.match(/kind\s+text not null check \(kind in \(([\s\S]*?)\)\)/)
    expect(m, 'kind CHECK not found').toBeTruthy()
    const kinds = [...(m?.[1] ?? '').matchAll(/'([a-z_]+)'/g)].map((x) => x[1]).sort()
    expect(kinds).toEqual([...MOVEMENT_KINDS].sort())
  })

  it('has the idempotency index on (kind, ref_type, ref_id, warehouse_code, sku)', () => {
    expect(up).toMatch(
      /create unique index stock_movements_once\s+on public\.stock_movements \(kind, ref_type, ref_id, warehouse_code, sku\)/,
    )
    // Both RPCs must conflict on it rather than raise.
    expect((up.match(/on conflict \(kind, ref_type, ref_id, warehouse_code, sku\) do nothing/g) ?? []).length).toBe(2)
  })

  it('keeps finished goods integral in the ledger', () => {
    expect(up).toMatch(/check \(item_kind = 'material' or quantity = trunc\(quantity\)\)/)
  })

  it('locks both new tables away from PostgREST', () => {
    expect(up).toMatch(/revoke all on public\.stock_movements from public, anon, authenticated/)
    expect(up).toMatch(/revoke all on public\.material_stock_levels from public, anon, authenticated/)
    expect(up).toMatch(/alter table public\.stock_movements enable row level security/)
    expect(up).toMatch(/alter table public\.material_stock_levels enable row level security/)
  })

  it('takes the direct UPDATE path on warehouse_stock_levels away from users', () => {
    expect(up).toMatch(/drop policy if exists "Authenticated users can update warehouse_stock_levels"/)
    expect(up).toMatch(/revoke insert, update, delete, truncate, references, trigger on public\.warehouse_stock_levels from authenticated/)
  })

  it('grants the RPCs to service_role only', () => {
    for (const fn of ['hub_apply_stock_movements(jsonb, uuid)', 'hub_record_stock_count(text, text, jsonb, uuid, uuid, text)']) {
      const esc = fn.replace(/[()]/g, (c) => `\\${c}`)
      expect(up).toMatch(new RegExp(`revoke all on function public\\.${esc} from public, anon, authenticated`))
      expect(up).toMatch(new RegExp(`grant execute on function public\\.${esc} to service_role`))
    }
  })

  it('seeds stock.view and installs the booking trigger', () => {
    expect(up).toMatch(/values \('stock\.view', 'stock'/)
    expect(up).toMatch(/create trigger trg_stock_on_booking\s+after insert or update of spot_id on public\.po_shipments/)
    // The trigger keys the deduction on the SRO leg, by id first, then by chain.
    expect(up).toMatch(/where id = new\.po_id and leg = 'EB_GROUP_TO_SRO'/)
    expect(up).toMatch(/s\.master_ref = p\.master_ref/)
  })

  it('retires the old writer', () => {
    expect(up).toMatch(/drop function if exists public\.increment_stock\(text, text, integer\)/)
  })

  it('has a rollback that drops every object the up file creates', () => {
    expect(existsSync(join(process.cwd(), DOWN))).toBe(true)
    const down = readFileSync(join(process.cwd(), DOWN), 'utf8')
    for (const needle of [
      'drop trigger if exists trg_stock_on_booking',
      'drop function if exists public.stock_on_booking()',
      'drop function if exists public.hub_record_stock_count(text, text, jsonb, uuid, uuid, text)',
      'drop function if exists public.hub_apply_stock_movements(jsonb, uuid)',
      'drop table if exists public.material_stock_levels',
      'drop table if exists public.stock_movements',
      'create or replace function public.increment_stock(p_warehouse text, p_sku text, p_delta integer)',
      "delete from public.capabilities where key = 'stock.view'",
    ]) {
      expect(down, needle).toContain(needle)
    }
  })
})
