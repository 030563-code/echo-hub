import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ORG_CODES } from '@/lib/organisations'

/**
 * The organisations migration and the code registry have to agree.
 *
 * user_organisations.organisation references entities(code), so a code the
 * migration does not seed is a grant that can never be written, and a row it
 * seeds that the code does not know is dropped by authz. Both fail silently as
 * "the tab is missing", which is why this is pinned here.
 */

const UP = readFileSync(join(process.cwd(), 'supabase/migrations/20260915180000_organisations.sql'), 'utf8')
const DOWN = readFileSync(
  join(process.cwd(), 'supabase/migrations/rollback/20260915180000_organisations.down.sql'),
  'utf8',
)

/** The SQL with every comment line removed, so a code in a comment does not count. */
const code = (sql: string) =>
  sql
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')

describe('the organisations migration', () => {
  const up = code(UP)

  it('seeds every organisation the code knows into entities', () => {
    // Four rows predate this migration; the other three are inserted here.
    const seededBefore = ['EB-USA', 'EB-CANADA', 'EB-GROUP', 'EB-SRO']
    for (const org of ORG_CODES) {
      if (seededBefore.includes(org)) continue
      expect(up, org).toMatch(new RegExp(`\\('${org}',\\s*'`))
    }
  })

  it('does not overwrite a tenant id somebody set by hand', () => {
    expect(up).toMatch(/xero_tenant_id is null/)
  })

  it('shapes the grant table like user_capabilities, closed to everything but reading own rows', () => {
    expect(up).toMatch(/create table public\.user_organisations/)
    expect(up).toMatch(/references public\.entities\(code\)/)
    expect(up).toMatch(/primary key \(user_id, organisation\)/)
    expect(up).toMatch(/enable row level security/)
    expect(up).toMatch(/revoke all on public\.user_organisations from public, anon, authenticated/)
    expect(up).toMatch(/grant select on public\.user_organisations to authenticated/)
    expect(up).toMatch(/user_id = \(select auth\.uid\(\)\) or \(select public\.is_super_admin\(\)\)/)
    expect(up).not.toMatch(/grant (insert|update|delete|all) on public\.user_organisations/)
  })

  it('fills the invoice organisation before making it required', () => {
    const add = up.indexOf('add column organisation_code')
    const fill = up.indexOf("set organisation_code = 'EB-USA'")
    const required = up.indexOf('alter column organisation_code set not null')
    expect(add).toBeGreaterThan(-1)
    expect(fill).toBeGreaterThan(add)
    expect(required).toBeGreaterThan(fill)
    // No default: a new row has to say which organisation it belongs to.
    expect(up).not.toMatch(/organisation_code[^\n]*default/)
  })

  it('teaches the create function to write the organisation from the header', () => {
    expect(up).toMatch(/create or replace function public\.create_customer_invoice/)
    expect(up).toMatch(/p_header->>'organisation_code'/)
    expect(up).toMatch(/security definer/)
  })

  it('seeds no grants: those are deliberate rows, not migration data', () => {
    expect(up).not.toMatch(/insert into public\.user_organisations/)
  })
})

describe('its rollback', () => {
  const down = code(DOWN)

  it('undoes every step in reverse', () => {
    expect(down).toMatch(/create or replace function public\.create_customer_invoice/)
    expect(down).not.toMatch(/organisation_code[^\n]*\n[^\n]*p_header->>'organisation_code'/)
    expect(down).toMatch(/drop column if exists organisation_code/)
    expect(down).toMatch(/drop table if exists public\.user_organisations/)
    expect(down).toMatch(/delete from public\.entities where code in \('EB-FRANCE', 'EB-AUSTRALIA', 'EB-UK'\)/)
  })
})
