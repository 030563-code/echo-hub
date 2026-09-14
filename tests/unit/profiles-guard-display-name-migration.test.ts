import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Pins the pending hardening migration (not applied until Dean says so).
 *
 * The rule: a non-super-admin cannot clear profiles.display_name, because a
 * blank name reopens onboarding, which rewrites pipeline, depots and templates
 * through the admin client. And get_next_quote_id loses its PUBLIC grant as well
 * as anon's, since the PUBLIC grant alone kept anon able to call it.
 */

const UP = 'supabase/migrations/pending/20260914140000_profiles_guard_display_name.sql'
const DOWN = 'supabase/migrations/rollback/20260914140000_profiles_guard_display_name.down.sql'

function code(path: string): string {
  return readFileSync(join(process.cwd(), path), 'utf8')
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n')
    .replace(/\s+/g, ' ')
}

describe('profiles display_name guard migration', () => {
  const raw = readFileSync(join(process.cwd(), UP), 'utf8')
  const up = code(UP)
  const down = code(DOWN)

  it('is marked as not applied and never pushed', () => {
    expect(raw.startsWith("-- NOT APPLIED. Needs Dean's go-ahead.")).toBe(true)
    expect(raw).toContain('Never db push.')
  })

  it('keeps the service_role early return and the existing authorization check', () => {
    expect(up).toContain("if coalesce(auth.role(), 'none') not in ('anon', 'authenticated') then return new; end if;")
    expect(up).toContain("raise exception 'profiles: authorization columns can only be changed by a super admin'")
  })

  it('refuses a change of display_name to null or blank by a non-super-admin', () => {
    expect(up).toContain(
      "if new.display_name is distinct from old.display_name and nullif(btrim(coalesce(new.display_name, '')), '') is null and not public.is_super_admin() then raise exception 'profiles: display_name cannot be cleared';",
    )
  })

  it('revokes get_next_quote_id from PUBLIC and anon, keeps authenticated and service_role', () => {
    expect(up).toContain('revoke execute on function public.get_next_quote_id() from public;')
    expect(up).toContain('revoke execute on function public.get_next_quote_id() from anon;')
    expect(up).toContain('grant execute on function public.get_next_quote_id() to authenticated;')
    expect(up).toContain('grant execute on function public.get_next_quote_id() to service_role;')
    expect(up).not.toMatch(/grant execute on function public\.get_next_quote_id\(\) to (public|anon)/)
  })

  it('rolls back to the guard without the display_name check and restores the grants', () => {
    expect(down).not.toContain('display_name')
    expect(down).toContain('grant execute on function public.get_next_quote_id() to public;')
    expect(down).toContain('grant execute on function public.get_next_quote_id() to anon;')
  })
})
