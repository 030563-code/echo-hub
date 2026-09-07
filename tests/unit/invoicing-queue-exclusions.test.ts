import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const read = (f: string) => readFileSync(join(process.cwd(), f), 'utf8')

describe('the accepted queue honours exclusions', () => {
  it('filters excluded deals out before building rows', () => {
    const page = read('src/app/(dashboard)/invoicing/accepted/page.tsx')
    expect(page).toContain('invoicing_queue_exclusions')
    // The filter has to sit inside stillWaiting, not on the render, or a deal
    // set aside would still count toward the queue being empty.
    expect(page).toMatch(/stillWaiting[\s\S]{0,200}excluded\.has/)
  })

  it('always shows what was set aside, so nothing disappears silently', () => {
    const page = read('src/app/(dashboard)/invoicing/accepted/page.tsx')
    expect(page).toContain('Set aside')
    expect(page).toContain('RestoreToQueueButton')
  })
})

describe('the exclusion actions are gated and validated', () => {
  const source = read('src/app/actions/invoicing/queue-exclusions.ts')

  it("checks invoicing.manage on every export, because 'use server' exports are endpoints", () => {
    const exports = source.match(/export async function (\w+)/g) ?? []
    expect(exports.length).toBeGreaterThan(0)
    // One gate per exported action.
    expect((source.match(/requireInvoicingManage\(\)/g) ?? []).length).toBe(exports.length)
  })

  it('takes a deal id as digits only and demands a reason', () => {
    expect(source).toMatch(/regex\(\/\^\\d\{1,20\}\$\//)
    expect(source).toContain('.max(300)')
  })

  it('is reversible', () => {
    expect(source).toContain('restoreDealToQueue')
    expect(source).toContain('.delete()')
  })
})

describe('the exclusions table is not reachable from a browser', () => {
  it('revokes everything from anon and authenticated', () => {
    const sql = read('supabase/migrations/20260907170000_invoicing_queue_exclusions.sql')
    // This project grants authenticated TRUNCATE on every new table by default
    // and RLS does not restrain TRUNCATE, so the revoke is the control.
    expect(sql).toMatch(/revoke all on public\.invoicing_queue_exclusions from public, anon, authenticated/)
    expect(sql).toContain('enable row level security')
  })
})
