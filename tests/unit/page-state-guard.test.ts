import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Every screen that holds state has to say what happens to it.
 *
 * The Hub lost people's work on every navigation because nothing made anyone
 * decide. This walks the client components and fails when one holds state
 * without either using the page-state hooks or declaring, in one line, why it
 * does not need to.
 *
 *   // page-state: draft quote-builder:{dealId}
 *   // page-state: view  po-board
 *   // page-state: none (dialog-scoped, committed on save)
 *
 * Modelled on hubspot-write-guard.test.ts, which does the same job for HubSpot
 * mutations.
 */

const ROOTS = ['src/app/(dashboard)', 'src/components']

/** Both quote styles appear in this tree, and the directive must be the first
 *  thing in the file, so anchor it rather than searching for the substring. */
const USE_CLIENT = /^\s*["']use client["']/m
const HOLDS_STATE = /\buse(State|Reducer)\s*[<(]/
const USES_PAGE_STATE = /@\/hooks\/use-page-state/
const MARKER = /\/\/\s*page-state:\s*(draft|view|none)\b/

function walk(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else if (entry.endsWith('.tsx')) out.push(full)
  }
  return out
}

const files = ROOTS.flatMap((root) => walk(join(process.cwd(), root)))

describe('every stateful client component declares what happens to its state', () => {
  it('finds the tree at all', () => {
    // A matcher that quietly stops matching would turn this whole file into a
    // test that always passes. Same self-check the HubSpot write guard uses.
    expect(files.length).toBeGreaterThan(40)
  })

  it('leaves nothing undeclared', () => {
    const undeclared = files.filter((file) => {
      const source = readFileSync(file, 'utf8')
      if (!USE_CLIENT.test(source)) return false
      if (!HOLDS_STATE.test(source)) return false
      if (USES_PAGE_STATE.test(source)) return false
      return !MARKER.test(source)
    })

    expect(
      undeclared.map((f) => f.replace(`${process.cwd()}/`, '')),
      'These client components hold state that dies on navigation. Either wire ' +
        'them to @/hooks/use-page-state, or add a one-line marker saying why not: ' +
        '// page-state: none (reason)',
    ).toEqual([])
  })
})
