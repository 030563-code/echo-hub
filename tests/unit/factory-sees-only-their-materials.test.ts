import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 🔴 The factory sees their own materials and one quantity of ours. Nothing else.
 *
 * Dean, 18 Sep 2026: show them a breakdown "based on THEIR material and not
 * reveal some of our internal information on our own material and quotes in the
 * system and those calculations". This is the price rule (see
 * factory-sees-only-their-prices.test.ts) applied to the rest of our position.
 *
 * The first cut of the product table printed "Firm orders 0, weighted quotes
 * 1,525, in stock 2,660, in transit 0, on order 350" under every row, in
 * Slovak, on their screen. That is our commercial position: how much we hold,
 * how much we have coming, and how big our open pipeline is. It shipped on 18
 * Sep 2026 and came off the same day.
 *
 * A grep is the right shape for this. The fields are gone from the type, so the
 * compiler already refuses the obvious mistake; what it cannot refuse is
 * somebody adding them back for a good reason. This makes that a deliberate act
 * with a failing test attached.
 */

const read = (f: string) => readFileSync(join(process.cwd(), f), 'utf8')

const walk = (dir: string): string[] => {
  const out: string[] = []
  for (const entry of readdirSync(join(process.cwd(), dir))) {
    const rel = `${dir}/${entry}`
    if (statSync(join(process.cwd(), rel)).isDirectory()) out.push(...walk(rel))
    else if (/\.tsx?$/.test(entry)) out.push(rel)
  }
  return out
}

/** Our flow position, in both spellings: the column and the field. */
const OURS = [
  'firmDemand',
  'weightedPipeline',
  'onHand',
  'inTransit',
  'onOrder',
  'firm_demand',
  'qualified_spikes',
  'on_hand',
  'in_transit',
  'on_order',
  'projected_nfp',
  'action_qty', // the one exception, allowed only where it is read. See below.
]

describe('nothing of ours reaches a factory screen', () => {
  const files = [...walk('src/app/(dashboard)/factory'), ...walk('src/lib/factory')]

  it('covers the whole factory surface', () => {
    expect(files.length).toBeGreaterThanOrEqual(12)
  })

  it('never names our stock, our shipments or our pipeline on a factory page', () => {
    for (const file of files) {
      const source = read(file)
      for (const term of OURS) {
        // action_qty is the quantity we want built, which is the whole point of
        // the screen. It is read in exactly one place and mapped to a single
        // field called `requirement`.
        if (term === 'action_qty') continue
        expect(source.includes(term), `${file} mentions ${term}`).toBe(false)
      }
    }
  })

  it('reads one column off the engine row and no others', () => {
    const loader = read('src/lib/factory/capability.ts')
    expect(loader).toContain("select('sku, run_date, action_qty, flags')")
    // The alert email is a factory surface too, and it reads the same row.
    const route = read('src/app/api/mrp/factory-alert/route.ts')
    expect(route).toContain("select('sku, run_date, action_qty, flags')")
    for (const term of OURS) {
      if (term === 'action_qty') continue
      expect(route.includes(term), `the alert route mentions ${term}`).toBe(false)
    }
  })

  it('sends the factory a payload of their own figures', () => {
    const route = read('src/app/api/mrp/factory-alert/route.ts')
    // What one product looks like in the email: a name, a quantity, their
    // ceiling, the material that caps it. No derivation, no money.
    expect(route).toContain('product_name: p.productName')
    expect(route).toContain('requirement: p.requirement')
    expect(route).toContain('max_buildable: p.maxBuildable')
    expect(route).not.toMatch(/price|cost|amount/i)
  })

  it('shows the breakdown from their parts list and their shelf', () => {
    const page = read('src/app/(dashboard)/factory/stock/[fg]/page.tsx')
    expect(page).toContain('productDraw(product, components, stockByCode, qty)')
    // Their stock feed, not our depot ledger.
    expect(page).toContain('loadFactoryStock()')
    expect(page).not.toMatch(/warehouse_stock_levels|deals_registry|mrp_demand/)
  })
})
