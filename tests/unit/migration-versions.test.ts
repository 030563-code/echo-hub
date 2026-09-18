import { describe, it, expect } from 'vitest'
import { readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Migration file versions, checked by a test instead of by remembering.
 *
 * A migration is identified by the 14 digits its filename starts with. Two
 * files with the same 14 digits is a real problem even when both are correct
 * SQL: `supabase db push`, `supabase migration list` and a fresh `db reset`
 * all key on that number, and the directory listing stops telling anyone which
 * of the two ran. It happened once already on this branch, silently, because
 * main merged a migration onto the same timestamp a pending file here was
 * already using.
 *
 * Nothing about the database is asserted here, only the filenames. This
 * project applies through the Supabase MCP, which stamps its own timestamp at
 * apply time, so the damage a collision does is confined to the repo.
 */

const MIGRATIONS = 'supabase/migrations'
const PENDING = join(MIGRATIONS, 'pending')
const ROLLBACK = join(MIGRATIONS, 'rollback')

/**
 * Pending migrations parked before main's current head, and deliberately not
 * renumbered: they were written against an older schema and whoever finally
 * applies them re-times them then. Anything added after them has to sort
 * later than every applied file.
 */
const PARKED = ['20260828000000', '20260902003000']

/**
 * Rollbacks became the habit on 10 Sep 2026 and every migration since carries
 * one. The 69 older files predate it and are left alone: writing a down
 * migration for a schema nobody remembers is how you get a rollback that does
 * more damage than the thing it undoes.
 *
 * Caught by a reviewer on 18 Sep 2026, after the only migration in nine without
 * a rollback shipped to production.
 */
const ROLLBACKS_EXPECTED_FROM = '20260910000000'

function sqlFiles(dir: string): string[] {
  return readdirSync(join(process.cwd(), dir))
    .filter((f) => f.endsWith('.sql'))
    .sort()
}

function version(file: string): string {
  const m = /^(\d{14})_/.exec(file)
  if (!m) throw new Error(`migration filename does not start with a 14-digit version: ${file}`)
  return m[1]
}

describe('migration versions', () => {
  it('gives every applied and pending migration its own version', () => {
    const seen = new Map<string, string>()
    const clashes: string[] = []
    for (const dir of [MIGRATIONS, PENDING]) {
      for (const file of sqlFiles(dir)) {
        const v = version(file)
        const first = seen.get(v)
        if (first) clashes.push(`${v}: ${first} and ${join(dir, file)}`)
        else seen.set(v, join(dir, file))
      }
    }
    expect(clashes).toEqual([])
  })

  it('numbers a new pending migration after every applied one', () => {
    const newestApplied = sqlFiles(MIGRATIONS).map(version).sort().at(-1)!
    for (const file of sqlFiles(PENDING)) {
      const v = version(file)
      if (PARKED.includes(v)) continue
      expect(
        v > newestApplied,
        `${file} must sort after the newest applied migration ${newestApplied}`,
      ).toBe(true)
    }
  })

  it('keeps a rollback beside every pending migration', () => {
    for (const file of sqlFiles(PENDING)) {
      const down = `${file.slice(0, -4)}.down.sql`
      expect(existsSync(join(process.cwd(), ROLLBACK, down)), `missing ${down}`).toBe(true)
    }
  })
})

describe('every recent migration can be undone', () => {
  it('has a matching .down.sql', () => {
    const missing = sqlFiles(MIGRATIONS)
      .filter((f) => version(f) >= ROLLBACKS_EXPECTED_FROM)
      .filter((f) => !existsSync(join(process.cwd(), ROLLBACK, f.replace(/\.sql$/, '.down.sql'))))
    expect(missing, `no rollback for: ${missing.join(', ')}`).toEqual([])
  })

  it('has no rollback for a migration that does not exist', () => {
    // pending/ counts: those two are written and waiting to be re-timed, and
    // their rollbacks were written with them.
    const applied = new Set(
      [...sqlFiles(MIGRATIONS), ...sqlFiles(PENDING)].map((f) => f.replace(/\.sql$/, '')),
    )
    const orphans = sqlFiles(ROLLBACK)
      .map((f) => f.replace(/\.down\.sql$/, ''))
      .filter((base) => !applied.has(base))
    expect(orphans, `rollback with no migration: ${orphans.join(', ')}`).toEqual([])
  })
})
