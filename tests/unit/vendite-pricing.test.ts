import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { priceCart, type CartLine } from '@/lib/quote-pricing'
import { urgentPerUnitDiscounts, amountCeiling, checkAmountCeiling } from '@/lib/agent-quote/guards'
import type { ListPriceRow, DiscountCap } from '@/lib/pricing'

/**
 * V0 layer L1: the pricing engine, for Vendite's EUR quotes.
 *
 * Dean, 19 Sep 2026: "There needs to be a testing framework E2E first before
 * production changes. We need to make sure it is quoting correct prices."
 *
 * Every expected number here is read from tests/fixtures/vendite-eur-basket.json
 * and was computed by hand, never by this code. That is the whole point: a
 * cross-check that reads the value it is checking checks nothing. If the engine
 * and the fixture disagree, one of them is wrong and a person decides which.
 *
 * Nothing here touches a network, a database or HubSpot. It runs on every commit.
 */

const fixture = JSON.parse(
  readFileSync(fileURLToPath(new URL('../fixtures/vendite-eur-basket.json', import.meta.url)), 'utf8'),
)

const LIST: readonly ListPriceRow[] = fixture.listPrices
const CAP: DiscountCap = fixture.cap
const TODAY: string = fixture.today
const CUR: string = fixture.currency

type FixtureLine = {
  sku: string
  quantity: number
  unit: string
  floor?: string | null
  discountMode?: 'percent' | 'amount'
  discountValue?: number
}

/** A cart line as the agent route builds one: the price always comes from the
 *  database, so unitPrice is 0 and a missing list row is a refusal, not a
 *  number the agent invented. */
function cartLines(lines: FixtureLine[], withDiscount = true): CartLine[] {
  return lines.map((l, i) => ({
    productId: `p${i}`,
    name: l.sku,
    quantity: l.quantity,
    sku: l.sku,
    unitPrice: 0,
    ...(withDiscount && l.discountMode
      ? { discountMode: l.discountMode, discountValue: l.discountValue }
      : {}),
  }))
}

function priceList(lines: FixtureLine[], withDiscount = true) {
  return priceCart({
    lines: cartLines(lines, withDiscount),
    currency: CUR,
    listPrices: LIST,
    cap: CAP,
    today: TODAY,
  })
}

/**
 * Urgent pricing, exactly as POST /api/agent/quote does it: price once to learn
 * the list price and the floor, turn the gap into a per-unit cash discount, then
 * price again so checkDiscount re-checks the cap AND the floor on the real
 * numbers. The agent never names a price at any point.
 */
function priceUrgent(lines: FixtureLine[]) {
  const base = priceList(lines, false)
  if (!base.ok) return { ok: false as const, stage: 'base' as const, error: base.error }
  const discounts = urgentPerUnitDiscounts(base.lines)
  if (discounts === null) return { ok: false as const, stage: 'floor' as const, error: 'NO_FLOOR' }
  const second = priceCart({
    lines: cartLines(lines, false).map((l, i) => ({
      ...l,
      discountMode: 'amount' as const,
      discountValue: discounts[i],
    })),
    currency: CUR,
    listPrices: LIST,
    cap: CAP,
    today: TODAY,
  })
  return second.ok
    ? { ok: true as const, ...second }
    : { ok: false as const, stage: 'discount' as const, error: second.error }
}

const b = fixture.baskets

describe('Vendite EUR pricing, list', () => {
  it('totals the everyday panels-plus-fitting-kit basket to the hand-computed figure', () => {
    const r = priceList(b.typical_kit.lines)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.total).toBe(b.typical_kit.expected.list_total)
    expect(r.lines).toHaveLength(b.typical_kit.expected.line_count)
  })

  it('keeps the fitting kit as one line per component, never split', () => {
    const r = priceList(b.typical_kit.lines)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const skus = r.lines.map((l) => l.sku)
    expect(skus).toEqual(['EBH10EU', 'HKEU', 'BUNEU'])
    expect(new Set(skus).size).toBe(skus.length)
  })

  it('prices a single panel without rounding drift', () => {
    const r = priceList(b.single_panel.lines)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.total).toBe(b.single_panel.expected.list_total)
  })

  it('takes every price from the database, never from the caller', () => {
    const r = priceList(b.typical_kit.lines)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    for (const line of r.lines) expect(line.priceSource).toBe('list')
  })
})

describe('Vendite EUR pricing, urgent floor', () => {
  it('totals the urgent basket to the hand-computed figure', () => {
    const r = priceUrgent(b.typical_kit.lines)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.total).toBe(b.typical_kit.expected.urgent_total)
  })

  it('lands every line exactly on its floor, never a cent under', () => {
    const r = priceUrgent(b.typical_kit.lines)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    for (const line of r.lines) {
      expect(line.floorPrice).not.toBeNull()
      expect(line.priced.netUnitPrice).toBe(Number(line.floorPrice))
    }
  })

  it('prices a single urgent panel at its floor', () => {
    const r = priceUrgent(b.single_panel.lines)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.total).toBe(b.single_panel.expected.urgent_total)
  })

  it('refuses the whole cart when any line has no floor', () => {
    const r = priceUrgent(b.no_floor_row.lines)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.stage).toBe('floor')
  })
})

describe('Vendite EUR pricing, the floor is the line that matters', () => {
  it('allows a discount landing exactly on the floor', () => {
    const r = priceList(b.floor_exact.lines)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.lines[0].priced.netUnitPrice).toBe(b.floor_exact.expected.net_unit)
    expect(r.total).toBe(b.floor_exact.expected.total)
  })

  it('refuses the same line one cent below the floor', () => {
    const r = priceList(b.one_cent_below_floor.lines)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.toLowerCase()).toContain(b.one_cent_below_floor.expected.refusal_mentions)
  })

  it('refuses any discount when the agent has no cap row at all', () => {
    const r = priceCart({
      lines: cartLines(b.floor_exact.lines),
      currency: CUR,
      listPrices: LIST,
      cap: null,
      today: TODAY,
    })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toContain('not allowed to apply a discount')
  })

  it('names the refusal in euros, not plain dollars', () => {
    const r = priceList(b.one_cent_below_floor.lines)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).not.toContain('$')
  })
})

describe('Vendite EUR pricing, rows the engine must not see', () => {
  it('never quotes from an inactive row', () => {
    const r = priceList([{ sku: 'EBH20EU', quantity: 1, unit: '900.00' }])
    expect(r.ok).toBe(true)
    if (!r.ok) return
    // No active EUR row, so it falls back to what the caller sent, which the
    // agent route sends as 0 and then refuses via checkListPriced.
    expect(r.lines[0].priceSource).toBe('manual')
    expect(r.lines[0].priced.listUnitPrice).toBe(0)
  })

  it('never crosses currency: a USD row for the same SKU is invisible to a EUR cart', () => {
    const r = priceList([{ sku: 'EBH10EU', quantity: 1, unit: '350.00' }])
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.lines[0].priced.listUnitPrice).toBe(350)
    expect(r.lines[0].priced.listUnitPrice).not.toBe(275)
  })

  it('refuses a discount on a SKU with no list row, because there is nothing to discount from', () => {
    const r = priceList(b.unpriced_sku.lines)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toContain('no list price')
  })
})

describe('Vendite EUR pricing, the panel and amount limits are independent', () => {
  it('prices 200 panels, the documented maximum, to the hand-computed figure', () => {
    const r = priceList(b.panel_limit.lines)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.total).toBe(b.panel_limit.expected.list_total)
    const panels = b.panel_limit.lines.reduce((n: number, l: FixtureLine) => n + l.quantity, 0)
    expect(panels).toBe(b.panel_limit.expected.panels)
  })

  it('still trips the amount ceiling at that size, so the two limits are not the same limit', () => {
    const r = priceList(b.panel_limit.lines)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(checkAmountCeiling(r.total, amountCeiling(undefined))).toBe('AMOUNT_CEILING')
  })

  it('and the urgent price of the same 200 panels falls under the ceiling', () => {
    const r = priceUrgent(b.panel_limit.lines)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.total).toBe(b.panel_limit.expected.urgent_total)
    expect(checkAmountCeiling(r.total, amountCeiling(undefined))).toBeNull()
  })
})
