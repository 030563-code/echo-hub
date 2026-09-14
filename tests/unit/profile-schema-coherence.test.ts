import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { AVATAR_BUCKET, AVATAR_MAX_BYTES, BIO_MAX, JOB_TITLE_MAX } from '@/lib/profile/avatar'

/**
 * The profile migration and the TypeScript that speaks to it must agree.
 *
 * Same genre as stock-schema-coherence.test.ts: read the migration and pin the
 * parts the code relies on. Above all, the grant: authenticated may update bio
 * and job_title and nothing else, because avatar_updated_at is only ever set by
 * the server after it has checked the upload is a real image.
 */

const MIG = 'supabase/migrations/20260914100000_profile_bio_avatar.sql'
const DOWN = 'supabase/migrations/rollback/20260914100000_profile_bio_avatar.down.sql'

/** SQL without its comments, so prose about policies cannot satisfy or trip a check. */
function stripComments(sql: string): string {
  return sql
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n')
}

const raw = readFileSync(join(process.cwd(), MIG), 'utf8')
const up = stripComments(raw)

describe('profile bio and avatar migration', () => {
  it('carries the house header', () => {
    expect(raw).toContain('Applied live via MCP apply_migration on korylyniwsqtsvzuzydg')
    expect(raw).toContain('Never db push.')
  })

  it('adds the three columns', () => {
    expect(up).toMatch(/add column job_title text/)
    expect(up).toMatch(/add column bio text/)
    expect(up).toMatch(/add column avatar_updated_at timestamptz/)
  })

  it('caps the job title at the length the app enforces', () => {
    expect(up).toContain(
      `add constraint profiles_job_title_length check (job_title is null or char_length(job_title) <= ${JOB_TITLE_MAX})`,
    )
  })

  it('caps the bio at the length the app enforces', () => {
    expect(up).toContain(`add constraint profiles_bio_length check (bio is null or char_length(bio) <= ${BIO_MAX})`)
  })

  it('grants update on bio and job_title to authenticated, and nothing else', () => {
    const grants = [...up.matchAll(/\bgrant\b[^;]*;/gi)].map((m) => m[0].replace(/\s+/g, ' ').trim())
    expect(grants).toEqual(['grant update (bio, job_title) on public.profiles to authenticated;'])
    expect(up).not.toMatch(/avatar_updated_at\)?\s+on public\.profiles to/)
  })

  it('creates a private avatars bucket with the upload cap and exactly three image types', () => {
    const m = up.match(
      /insert into storage\.buckets \(id, name, public, file_size_limit, allowed_mime_types\)\s*values \('([^']+)', '([^']+)', (true|false), (\d+),\s*array\[([^\]]*)\]\)\s*on conflict \(id\) do nothing;/,
    )
    expect(m, 'bucket insert not found').toBeTruthy()
    const [, id, name, isPublic, limit, mimes] = m ?? []
    expect(id).toBe(AVATAR_BUCKET)
    expect(name).toBe(AVATAR_BUCKET)
    expect(isPublic).toBe('false')
    expect(Number(limit)).toBe(AVATAR_MAX_BYTES)
    expect(Number(limit)).toBe(524288)
    const types = [...(mimes ?? '').matchAll(/'([^']+)'/g)].map((x) => x[1]).sort()
    expect(types).toEqual(['image/jpeg', 'image/png', 'image/webp'])
  })

  it('adds no storage.objects policies, so every object op goes through the server', () => {
    expect(up).not.toMatch(/create policy/i)
    expect(up).not.toMatch(/storage\.objects/i)
  })

  it('leaves the authorization guard trigger alone', () => {
    expect(up).not.toMatch(/profiles_guard_authz/)
  })

  it('has a rollback that reverses each object', () => {
    expect(existsSync(join(process.cwd(), DOWN))).toBe(true)
    const down = stripComments(readFileSync(join(process.cwd(), DOWN), 'utf8'))
    for (const needle of [
      'drop constraint if exists profiles_job_title_length',
      'drop constraint if exists profiles_bio_length',
      'revoke update (bio, job_title) on public.profiles from authenticated',
      'drop column if exists job_title',
      'drop column if exists bio',
      'drop column if exists avatar_updated_at',
    ]) {
      expect(down, needle).toContain(needle)
    }
    // The bucket goes only when it is empty.
    const del = down.match(
      /delete from storage\.buckets\s+where id = 'avatars'\s+and not exists \(select 1 from storage\.objects where bucket_id = 'avatars'\)/,
    )
    expect(del, 'guarded bucket delete not found').toBeTruthy()
    // protect_buckets_delete is a statement-level trigger, so it raises 42501
    // even when the guard matches no row, unless this transaction-local setting
    // is on first. Without it the rollback aborts as a whole.
    const allow = down.match(/select set_config\('storage\.allow_delete_query', 'true', true\);/)
    expect(allow, 'transaction-local set_config for storage.allow_delete_query not found').toBeTruthy()
    expect(allow!.index!).toBeLessThan(del!.index!)
    // Nothing else sits between them, so the setting is on for that delete.
    const between = down.slice(allow!.index! + allow![0].length, del!.index!)
    expect(between.trim()).toBe('')
  })
})
