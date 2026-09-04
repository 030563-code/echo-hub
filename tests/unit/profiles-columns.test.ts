import { describe, it, expect } from 'vitest'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * public.profiles has no email column.
 *
 * getRepsForCaps selected one. PostgREST rejects the whole query for an unknown
 * column, the function logged the error and returned an empty array, and the
 * discount caps page then told everyone "no reps to show" including super
 * admins. Because a rep with no cap cannot discount at all, and that page is the
 * only way to set a cap, the entire discounting feature was off and the screen
 * blamed the viewer's own profile for it.
 *
 * Nothing in a unit test can reach the database, so this reads the source
 * instead: any select on profiles naming a column that is not really there
 * fails here rather than silently at runtime.
 */

/** Live columns of public.profiles, checked against information_schema on
 *  2026-09-04. Add to this list when a migration adds a column. */
const PROFILE_COLUMNS = new Set([
  'id',
  'display_name',
  'is_super_admin',
  'hubspot_team_id',
  'allowed_depots',
  'allowed_quote_templates',
  'allowed_distributors',
  'pipeline_id',
  'created_at',
  'updated_at',
  'phone',
  '*',
])

async function sourceFiles(dir: string): Promise<string[]> {
  const out: string[] = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...(await sourceFiles(full)))
    else if (/\.tsx?$/.test(entry.name)) out.push(full)
  }
  return out
}

describe('selects on public.profiles', () => {
  it('only ask for columns that exist', async () => {
    const offenders: string[] = []

    for (const file of await sourceFiles('src')) {
      const source = await readFile(file, 'utf8')
      // .from('profiles') ... .select('a, b, c'), tolerating whatever sits
      // between them (an .eq, a line break, a comment).
      const pattern = /\.from\(\s*['"]profiles['"]\s*\)[\s\S]{0,400}?\.select\(\s*['"]([^'"]+)['"]/g
      for (const match of source.matchAll(pattern)) {
        for (const raw of match[1].split(',')) {
          const column = raw.trim()
          if (column === '') continue
          if (!PROFILE_COLUMNS.has(column)) {
            offenders.push(`${file}: profiles has no column "${column}"`)
          }
        }
      }
    }

    expect(offenders, offenders.join('\n')).toEqual([])
  })
})
