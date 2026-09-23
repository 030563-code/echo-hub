import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Pins public.hub_quoted_deals, applied 23 Sep 2026: the one definition of "quoted in the Hub",
 * read by the board's EH mark and by the CSO's desk pack.
 *
 * It exposes which deals a person quoted, so it must stay server only: security_invoker, and not a
 * single grant to the two roles a browser holds.
 */

const UP = 'supabase/migrations/20260923120000_hub_quoted_deals.sql'
const DOWN = 'supabase/migrations/rollback/20260923120000_hub_quoted_deals.down.sql'

function code(path: string): string {
  return readFileSync(join(process.cwd(), path), 'utf8')
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n')
    .replace(/\s+/g, ' ')
}

describe('hub_quoted_deals migration', () => {
  const raw = readFileSync(join(process.cwd(), UP), 'utf8')
  const up = code(UP)
  const down = code(DOWN)

  it('records where it ran, and that it was never pushed', () => {
    expect(raw).toContain('Applied live to korylyniwsqtsvzuzydg via MCP apply_migration on 23 Sep 2026')
    expect(raw).toContain('Never db push.')
  })

  it('is a security_invoker view that only the server may read', () => {
    expect(up).toContain('create or replace view public.hub_quoted_deals with (security_invoker = true) as')
    expect(up).toContain('revoke all on public.hub_quoted_deals from public, anon, authenticated;')
    expect(up).toContain('grant select on public.hub_quoted_deals to service_role;')
    expect(up).not.toMatch(/grant [^;]* to [^;]*\b(anon|authenticated)\b/)
  })

  it('counts a quote somebody received, not a draft or a failed publish', () => {
    expect(up).toContain("where q.status in ('published', 'editing')")
    expect(up).not.toMatch(/'draft'|'failed'/)
  })

  it("takes a builder reference, never the deal's own id, as a Hub quote from before 3 Sep 2026", () => {
    expect(up).toContain("where nullif(btrim(r.quote_reference), '') is not null")
    expect(up).toContain('and btrim(r.quote_reference) <> btrim(r.hubspot_deal_id)')
    expect(up).toContain('full join builder b on b.hubspot_deal_id = p.hubspot_deal_id')
  })

  it('rolls back by dropping the view and nothing else', () => {
    expect(down.trim()).toBe('drop view if exists public.hub_quoted_deals;')
  })
})
