import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Pins the negotiated-pricing migration, applied 2026-09-23.
 *
 * It only widens deal_quotes_pricing_mode_check to take 'negotiated'. A
 * negotiated quote carries no accept_by, which the untouched accept_by check
 * already demands of anything that is not urgent.
 */

const UP = 'supabase/migrations/20260923160000_deal_quotes_negotiated_pricing.sql'
const DOWN = 'supabase/migrations/rollback/20260923160000_deal_quotes_negotiated_pricing.down.sql'

function code(path: string): string {
  return readFileSync(join(process.cwd(), path), 'utf8')
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n')
    .replace(/\s+/g, ' ')
}

describe('deal_quotes negotiated pricing migration', () => {
  const raw = readFileSync(join(process.cwd(), UP), 'utf8')
  const up = code(UP)
  const down = code(DOWN)

  it('records where it ran, and that it was never pushed', () => {
    expect(raw.startsWith('-- APPLIED 2026-09-23 via MCP apply_migration')).toBe(true)
    expect(raw).toContain('Never db push.')
  })

  it('allows list, urgent and negotiated, with null reading as list', () => {
    expect(up).toContain("check (pricing_mode is null or pricing_mode in ('list', 'urgent', 'negotiated'))")
  })

  it('replaces the one check by name, in one transaction, and touches nothing else', () => {
    expect(up).toContain('alter table public.deal_quotes drop constraint if exists deal_quotes_pricing_mode_check;')
    expect(up).toContain('alter table public.deal_quotes add constraint deal_quotes_pricing_mode_check')
    expect(up.trim().startsWith('begin;')).toBe(true)
    expect(up.trim().endsWith('commit;')).toBe(true)
    expect(up).not.toMatch(/accept_by_check|add column|update public\.deal_quotes|drop column/)
  })

  it('rolls back to list and urgent only', () => {
    expect(down).toContain("check (pricing_mode is null or pricing_mode in ('list', 'urgent'))")
    expect(down.trim().startsWith('begin;')).toBe(true)
  })
})
