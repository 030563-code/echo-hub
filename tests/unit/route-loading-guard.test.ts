import { describe, it, expect } from 'vitest'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

/**
 * Every screen tells you it is loading, and tells you the truth about WHICH screen.
 *
 * Dean, 17 Sep 2026: "The edit specification should also have some ghost screen that gives the
 * user feedback on it loading so should every other screen really."
 *
 * 🔴 In the App Router a missing loading.tsx does not mean "no skeleton", it means "the nearest
 * ANCESTOR's skeleton". So the specification editor drew the purchase order KANBAN BOARD while it
 * loaded, and the single order page did too: you navigated into a form and saw the list you had
 * just left. That is worse than a blank screen, because it looks like the navigation failed.
 *
 * The rule this pins: a route whose own segment is dynamic, or which sits under a dynamic segment,
 * shows one record or one form and can never be served by a list skeleton. It needs its own.
 */

const DASHBOARD = join(process.cwd(), 'src/app/(dashboard)')

function routes(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (!statSync(full).isDirectory()) continue
    if (existsSync(join(full, 'page.tsx'))) acc.push(full)
    routes(full, acc)
  }
  return acc
}

/** A route that renders one record or one form: its path contains a [dynamic] segment. */
const isRecordRoute = (path: string) => relative(DASHBOARD, path).includes('[')

describe('route loading screens', () => {
  const all = routes(DASHBOARD)

  it('finds the dashboard routes at all, so a rename cannot quietly empty this test', () => {
    expect(all.length).toBeGreaterThan(30)
    expect(all.some((r) => r.endsWith('purchase-orders/[id]/specification'))).toBe(true)
  })

  it('gives every record and form route its own loading.tsx', () => {
    const missing = all
      .filter(isRecordRoute)
      .filter((r) => !existsSync(join(r, 'loading.tsx')))
      .map((r) => relative(DASHBOARD, r))

    expect(
      missing,
      `These routes would inherit an ancestor's list skeleton and flash the wrong screen:\n  ${missing.join('\n  ')}`,
    ).toEqual([])
  })

  it('covers the specification editor specifically, which is what started this', () => {
    expect(
      existsSync(join(DASHBOARD, 'purchase-orders/[id]/specification/loading.tsx')),
    ).toBe(true)
    expect(existsSync(join(DASHBOARD, 'purchase-orders/[id]/loading.tsx'))).toBe(true)
  })

  it('keeps the two shared shapes available, so a new route does not hand-roll one', () => {
    const lib = join(process.cwd(), 'src/components/ui/loading-skeleton.tsx')
    const source = readFileSync(lib, 'utf8')
    for (const shape of ['PageSkeleton', 'FormSkeleton', 'DetailSkeleton']) {
      expect(source).toContain(`export function ${shape}`)
    }
  })
})
