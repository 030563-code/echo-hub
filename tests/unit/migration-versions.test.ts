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
