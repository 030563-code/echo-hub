import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Pins the pending urgent-pricing migration (not applied until Dean says so).
 *
 * Four nullable columns on deal_quotes: which price a Jack quote was, when the
 * urgent offer closes, which urgent quote a reissue replaces, and why a floor
 * price was offered at all. Nullable and unbackfilled on purpose, so a quote a
 * rep raised is untouched by this in both directions.
 */

const UP = 'supabase/migrations/pending/20260914161000_deal_quotes_agent_pricing.sql'
const DOWN = 'supabase/migrations/rollback/20260914161000_deal_quotes_agent_pricing.down.sql'

function code(path: string): string {
  return readFileSync(join(process.cwd(), path), 'utf8')
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n')
    .replace(/\s+/g, ' ')
}

describe('deal_quotes agent pricing migration', () => {
  const raw = readFileSync(join(process.cwd(), UP), 'utf8')
  const up = code(UP)
  const down = code(DOWN)

  it('is marked as not applied and never pushed', () => {
    expect(raw.startsWith("-- NOT APPLIED. Needs Dean's go-ahead")).toBe(true)
    expect(raw).toContain('Never db push.')
    expect(raw).toContain('the same window as')
  })

  it('adds the four columns, every one nullable and none backfilled', () => {
    for (const column of ['pricing_mode text', 'accept_by    timestamptz', 'reissue_of   uuid', 'urgency_note text']) {
      expect(raw).toContain(`add column if not exists ${column}`)
    }
    // No NOT NULL and no DEFAULT on the new columns, and no backfill: an
    // existing row keeps reading as an ordinary list quote raised by a person.
    expect(up).not.toMatch(/add column[^;]*\bnot null\b/)
    expect(up).not.toMatch(/add column[^;]*\bdefault\b/)
    expect(up).not.toMatch(/\bupdate public\.deal_quotes\b/)
  })

  it('allows only list and urgent, with null reading as list', () => {
    expect(up).toContain("check (pricing_mode is null or pricing_mode in ('list', 'urgent'))")
  })

  it('ties the acceptance deadline to urgent pricing in both directions', () => {
    expect(up).toContain("check ((pricing_mode = 'urgent') = (accept_by is not null))")
  })

  it('caps the urgency note at the 200 characters the route accepts', () => {
    expect(up).toContain('check (urgency_note is null or length(urgency_note) <= 200)')
  })

  it('points a reissue at the quote it replaces without cascading a delete', () => {
    expect(up).toContain('foreign key (reissue_of) references public.deal_quotes(id) on delete set null')
    expect(up).not.toContain('on delete cascade')
  })

  it('indexes the two reads: the urgent cap and the foreign key', () => {
    expect(up).toContain("create index if not exists deal_quotes_urgent_idx on public.deal_quotes (hubspot_deal_id, created_at desc) where pricing_mode = 'urgent'")
    expect(up).toContain('create index if not exists deal_quotes_reissue_of_idx on public.deal_quotes (reissue_of) where reissue_of is not null')
  })

  it('grants nothing: deal_quotes is service-role only', () => {
    expect(up).not.toMatch(/\bgrant\b/)
  })

  it('runs as one transaction, both ways', () => {
    for (const sql of [up, down]) {
      expect(sql.trim().startsWith('begin;')).toBe(true)
      expect(sql.trim().endsWith('commit;')).toBe(true)
    }
  })

  it('rolls back every column, constraint and index it added', () => {
    for (const column of ['pricing_mode', 'accept_by', 'reissue_of', 'urgency_note']) {
      expect(down).toContain(`drop column if exists ${column}`)
    }
    for (const name of ['deal_quotes_pricing_mode_check', 'deal_quotes_accept_by_check', 'deal_quotes_urgency_note_check', 'deal_quotes_reissue_of_fkey']) {
      expect(down).toContain(`drop constraint if exists ${name}`)
    }
    expect(down).toContain('drop index if exists public.deal_quotes_urgent_idx')
    expect(down).toContain('drop index if exists public.deal_quotes_reissue_of_idx')
  })

  it('says out loud that the rollback destroys the discount audit', () => {
    const rawDown = readFileSync(join(process.cwd(), DOWN), 'utf8')
    expect(rawDown).toContain('DROPS the four columns')
    expect(rawDown).toContain('Roll the Hub back at the same time')
  })

  it('does not reuse a migration version already on main', () => {
    const applied = readdirSync(join(process.cwd(), 'supabase/migrations')).filter((f) => f.endsWith('.sql'))
    const pending = readdirSync(join(process.cwd(), 'supabase/migrations/pending')).filter((f) => f.endsWith('.sql'))
    const versions = [...applied, ...pending].map((f) => f.slice(0, 14))
    expect(new Set(versions).size).toBe(versions.length)
  })
})
