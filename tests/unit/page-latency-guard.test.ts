import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The three latency rules from 16 Sep 2026, when the server moved to London
 * next to the database and the remaining time was found in the code.
 *
 * Source grep, the house style. Each of these is one edit away from being
 * undone by somebody tidying: a helper un-wrapped, a Promise.all split back
 * into awaits, a Suspense boundary removed.
 */
const read = (f: string) => readFileSync(join(process.cwd(), f), 'utf8')
const code = (f: string) =>
  read(f)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')

describe('one session lookup per request', () => {
  it('getAuthorizedUser is deduped with React cache()', () => {
    const src = code('src/lib/authz.ts')
    expect(src).toContain("import { cache } from 'react'")
    expect(src).toMatch(/export const getAuthorizedUser = cache\(async function getAuthorizedUser\(\)/)
    // Never across requests: no module-level state, no TTL.
    expect(src).not.toMatch(/unstable_cache|Date\.now\(\)\s*-/)
  })

  it('loadOwnProfile is deduped the same way', () => {
    const src = code('src/lib/profile/load-own-profile.ts')
    expect(src).toMatch(/export const loadOwnProfile = cache\(async function loadOwnProfile\(userId: string\)/)
  })
})

describe('the purchase orders page fetches its follow-ups in one round', () => {
  const src = code('src/app/(dashboard)/purchase-orders/page.tsx')

  it('runs receipts, attachments, shipments, manufacturing and PDF data in one Promise.all', () => {
    const start = src.indexOf('const [receiptsRes, attsRes, shipRes, mfgRes, poPdfData] = await Promise.all([')
    expect(start).toBeGreaterThan(-1)
    const block = src.slice(start, src.indexOf(']);', start))
    for (const table of ['po_line_receipts', 'po_attachments', 'po_shipments', 'po_manufacturing']) {
      expect(block, table).toContain(`"${table}"`)
    }
    expect(block).toContain('getPoPdfData(supabase)')
  })

  it('has exactly one await against the database after the orders load', () => {
    const afterOrders = src.slice(src.indexOf('const all = stripPurchaseOrderCosts('))
    expect((afterOrders.match(/await /g) ?? []).length).toBe(1)
  })
})

describe('the deals board streams behind its shell', () => {
  const src = code('src/app/(dashboard)/quotes/board/page.tsx')

  it('waits on HubSpot inside a Suspense boundary, not in the page body', () => {
    expect(src).toContain('<Suspense fallback=')
    // The page body renders and returns before the HubSpot call is reached.
    const pageReturn = src.indexOf('return (\n    <div className="space-y-4">')
    const hubspotCall = src.indexOf('await getDealsForBoard(')
    expect(pageReturn).toBeGreaterThan(-1)
    expect(hubspotCall).toBeGreaterThan(pageReturn)
  })

  it('still gates on the capability before anything is sent', () => {
    const gate = src.indexOf("await requireCapability(['quotes.view', 'quotes.create'])")
    expect(gate).toBeGreaterThan(-1)
    expect(gate).toBeLessThan(src.indexOf('return ('))
  })

  it('clamps scope in the shell exactly as the action does', () => {
    expect(src).toContain("const isAdmin = auth.profile.is_super_admin === true || auth.capabilities.has('admin')")
    expect(code('src/app/actions/hubspot/getDealsForBoard.ts')).toContain(
      "const isAdmin = auth.profile.is_super_admin === true || auth.capabilities.has('admin')",
    )
  })
})
