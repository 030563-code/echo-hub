import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { customsPackageSchema } from '@/lib/customs/nippon-invoice'
import {
  costsFromBills,
  effectiveLocalCosts,
  landedCost,
  sameInvoice,
  toLanded,
  type CostInvoice,
  type CostLine,
} from '@/lib/transport/landed-cost'
import { landedCostAllowed, landedCurrency } from '@/lib/transport/cost-access'

/**
 * Dean, 24 Sep 2026: the landed cost per barrier, as Dave works it on his tab. Every number here is
 * invented (the repository is public), but the container has the shape of a real one: two
 * products on two euro invoices from Group, an entry summary with one line per invoice, and
 * Nippon's usual charges.
 */

const invoice = (id: string, number: string, over: Partial<CostInvoice> = {}): CostInvoice => ({
  id,
  number,
  currency: 'EUR',
  rate: 0.8,
  palletising: 400,
  delivery: 2000,
  insurance: 80,
  otherAmount: 0,
  ...over,
})

const LINES: CostLine[] = [
  { id: 'herc', productCode: 'H10HERCB', quantity: 280, pallets: 4, invoiceId: 'a', goodsAmount: 28000 },
  { id: 'h9', productCode: 'H9BALT', quantity: 280, pallets: 4, invoiceId: 'b', goodsAmount: 22400 },
]
const INVOICES = [invoice('a', 'EBGS000001'), invoice('b', 'EBGS000002')]

const BILL = customsPackageSchema.parse({
  invoice: {
    invoice_number: 'NEU-0001',
    invoice_date: '2026-03-01',
    total: 4080.06,
    charges: [
      { label: 'ESTIMATED CSTMS DUTY/FEES', amount: 3635.98 },
      { label: 'BROKERAGE ENTRY SERVICES', amount: 150 },
      { label: 'FORWARDING & HANDLING CHG', amount: 150 },
      { label: 'ISF FILING CHARGE', amount: 35 },
      { label: 'DUTY DISBURSMENT', amount: 109.08 },
    ],
  },
  entry: {
    entry_number: '000 0000001-1',
    entry_date: '2026-02-20',
    total_entered_value: 63000,
    duty_total: 3339,
    other_total: 296.98,
    total: 3635.98,
    mpf_total: 218.23,
    hmf_total: 78.75,
    lines: [
      // CBP printed this one without its series.
      { line_no: '001', invoice_number: '000002', entered_value: 28000, mpf: 96.99, hts: [{ code: '3925.90.0000', rate: 0.053, amount: 1484 }] },
      { line_no: '002', invoice_number: 'EBGS000001', entered_value: 35000, mpf: 121.24, hts: [{ code: '3925.90.0000', rate: 0.053, amount: 1855 }] },
    ],
  },
})

describe('an invoice in another currency', () => {
  it('is divided by the rate Xero shows, to the cent', () => {
    // "1 USD = 0.85 EUR": dollars are euros divided by 0.85.
    expect(toLanded(1000, { currency: 'EUR', rate: 0.85 }, 'USD')).toBe(1176.47)
    expect(toLanded(1000, { currency: 'USD', rate: null }, 'USD')).toBe(1000)
    expect(toLanded(1000, { currency: 'EUR', rate: null }, 'USD')).toBeNull()
  })
})

describe("CBP's invoice numbers", () => {
  it('match the invoice even when the series is dropped', () => {
    expect(sameInvoice('EBGS202600001', '202600001')).toBe(true)
    expect(sameInvoice('ebgs-202600001', 'EBGS202600001')).toBe(true)
    expect(sameInvoice('EBGS202600001', 'EBGS202600002')).toBe(false)
    // Too short to be sure it is the same number.
    expect(sameInvoice('EBGS00001', '00001')).toBe(false)
  })
})

describe('what Nippon billed, as local costs', () => {
  it('takes duty and both fees per Group invoice from the entry, and sorts the charges', () => {
    const bills = costsFromBills([BILL])!
    expect(bills.hasEntry).toBe(true)
    expect(bills.local.duty).toEqual({
      total: 3339,
      byInvoice: [
        { invoiceNumber: '000002', amount: 1484 },
        { invoiceNumber: 'EBGS000001', amount: 1855 },
      ],
    })
    expect(bills.local.mpf?.byInvoice).toEqual([
      { invoiceNumber: '000002', amount: 96.99 },
      { invoiceNumber: 'EBGS000001', amount: 121.24 },
    ])
    // The harbour fee follows each line's value: 0.125% of 28,000 and of 35,000.
    expect(bills.local.hmf?.byInvoice).toEqual([
      { invoiceNumber: '000002', amount: 35 },
      { invoiceNumber: 'EBGS000001', amount: 43.75 },
    ])
    // Nippon's 3% for paying the duty is Dave's deferment fee; the rest clears the container.
    expect(bills.local.disbursement).toEqual({ total: 109.08 })
    expect(bills.local.clearance).toEqual({ total: 335 })
    expect(bills.local.containerDelivery).toBeNull()
  })

  it('counts the one duty and fees charge as duty when the entry summary is missing', () => {
    const bills = costsFromBills([{ ...BILL, entry: null }])!
    expect(bills.hasEntry).toBe(false)
    expect(bills.local.duty).toEqual({ total: 3635.98 })
    expect(bills.notes[0]).toContain('has no entry summary')
  })

  it('is nothing when there is no bill', () => {
    expect(costsFromBills([])).toBeNull()
  })
})

describe('what was typed and what Nippon billed', () => {
  it('uses the typed draft until a bill arrives', () => {
    const { local, source } = effectiveLocalCosts({ duty: 3000, containerDelivery: 300 }, null)
    expect(local.duty).toEqual({ total: 3000 })
    expect(source).toMatchObject({ duty: 'typed', containerDelivery: 'typed', mpf: null })
  })

  it("lets the bill replace the draft where it has the figure, and keeps a trucker's delivery typed by hand", () => {
    const { local, source } = effectiveLocalCosts({ duty: 3000, mpf: 1, containerDelivery: 300 }, costsFromBills([BILL]))
    expect(local.duty?.total).toBe(3339)
    expect(local.mpf?.total).toBe(218.23)
    expect(local.containerDelivery).toEqual({ total: 300 })
    expect(source).toMatchObject({ duty: 'bill', mpf: 'bill', hmf: 'bill', clearance: 'bill', containerDelivery: 'typed' })
  })

  it('never counts a typed fee on top of a bill that has it inside its one duty and fees charge', () => {
    const { local, source } = effectiveLocalCosts({ mpf: 200, hmf: 70 }, costsFromBills([{ ...BILL, entry: null }]))
    expect(local.mpf).toBeNull()
    expect(local.hmf).toBeNull()
    expect(source.mpf).toBe('bill')
  })

  it("takes Nippon's delivery over the typed one when Nippon delivered", () => {
    const delivered = customsPackageSchema.parse({
      ...BILL,
      invoice: { ...BILL.invoice, charges: [...BILL.invoice.charges, { label: 'DRAYAGE TO DEPOT', amount: 650 }] },
    })
    const { local, source } = effectiveLocalCosts({ containerDelivery: 300 }, costsFromBills([delivered]))
    expect(local.containerDelivery).toEqual({ total: 650 })
    expect(source.containerDelivery).toBe('bill')
  })
})

describe('the landed cost of each product', () => {
  const local = effectiveLocalCosts({ containerDelivery: 300 }, costsFromBills([BILL])).local
  const result = landedCost({ currency: 'USD', lines: LINES, invoices: INVOICES, local })
  const [herc, h9] = result.lines

  it("gives each product its own invoice's barriers and charges", () => {
    expect(herc.parts).toMatchObject({ goods: 35000, palletising: 500, delivery: 2500, insurance: 100 })
    expect(h9.parts).toMatchObject({ goods: 28000, palletising: 500, delivery: 2500, insurance: 100 })
  })

  it('takes duty and the fees from the entry line of each Group invoice', () => {
    expect(herc.parts).toMatchObject({ duty: 1855, mpf: 121.24, hmf: 43.75 })
    expect(h9.parts).toMatchObject({ duty: 1484, mpf: 96.99, hmf: 35 })
  })

  it('puts the disbursement with the duty and fees, and the rest by pallets', () => {
    // 109.08 in step with 2,019.99 and 1,615.99 of CBP charges.
    expect(herc.parts.disbursement).toBe(60.6)
    expect(h9.parts.disbursement).toBe(48.48)
    expect(herc.parts).toMatchObject({ clearance: 167.5, containerDelivery: 150 })
    expect(h9.parts).toMatchObject({ clearance: 167.5, containerDelivery: 150 })
  })

  it('divides by the barriers, and carries four decimals to the PO', () => {
    expect(herc.total).toBe(40498.09)
    expect(herc.unitCost).toBeCloseTo(144.636036, 6)
    expect(herc.xeroUnit).toBe(144.636)
    // 280 at 144.6360 is a cent under the total: shown, not hidden.
    expect(herc.xeroAmount).toBe(40498.08)
    expect(h9.total).toBe(33081.97)
    expect(h9.xeroUnit).toBe(118.1499)
    expect(h9.xeroAmount).toBe(33081.97)
  })

  it('adds up to everything billed, and says it is complete', () => {
    expect(result.total).toBe(73580.06)
    expect(result.totals.duty).toBe(3339)
    expect(result.missing).toEqual([])
    expect(result.notes).toEqual([])
  })
})

describe('one invoice carrying two products', () => {
  it('shares its palletising, delivery and insurance by pallets', () => {
    const lines: CostLine[] = [
      { id: 'x', productCode: 'H9BALT', quantity: 420, pallets: 6, invoiceId: 'a', goodsAmount: 42000 },
      { id: 'y', productCode: 'CS1BALT', quantity: 5, pallets: 2, invoiceId: 'a', goodsAmount: 5000 },
    ]
    const result = landedCost({
      currency: 'USD',
      lines,
      invoices: [invoice('a', 'EBGS000003', { currency: 'USD', rate: null, palletising: 800, delivery: 8000, insurance: 100 })],
      local: { duty: { total: 4700 } },
    })
    expect(result.lines[0].parts).toMatchObject({ palletising: 600, delivery: 6000, insurance: 75 })
    expect(result.lines[1].parts).toMatchObject({ palletising: 200, delivery: 2000, insurance: 25 })
    // Typed duty goes by value: 42,600 and 5,200 of barriers plus palletising.
    expect(result.lines[0].parts.duty).toBe(4188.7)
    expect(result.lines[1].parts.duty).toBe(511.3)
  })
})

describe('what is still missing', () => {
  it('says so, gives no unit cost, and shares by pallets meanwhile', () => {
    const result = landedCost({
      currency: 'USD',
      lines: [LINES[0], { ...LINES[1], invoiceId: null, goodsAmount: null }],
      invoices: [INVOICES[0]],
      local: { duty: { total: 3000 } },
    })
    expect(result.missing).toEqual(["the H9BALT line's amount on its commercial invoice"])
    expect(result.lines[1].unitCost).toBeNull()
    expect(result.lines[0].unitCost).not.toBeNull()
    expect(result.lines.map((l) => l.parts.duty)).toEqual([1500, 1500])
    expect(result.notes).toContain('Until every product has its invoice amount, the duty and fees are shared by pallets.')
  })

  it('refuses to guess an exchange rate', () => {
    const result = landedCost({
      currency: 'USD',
      lines: [LINES[0]],
      invoices: [invoice('a', 'EBGS000001', { rate: null })],
      local: {},
    })
    expect(result.missing).toEqual(['the exchange rate on EBGS000001'])
    expect(result.lines[0].parts.goods).toBe(0)
    expect(result.lines[0].unitCost).toBeNull()
  })

  it('names an invoice that has charges but no products on it', () => {
    const result = landedCost({
      currency: 'USD',
      lines: [LINES[0]],
      invoices: [INVOICES[0], invoice('b', 'EBGS000002')],
      local: {},
    })
    expect(result.notes).toContain('EBGS000002 has no products on it yet, so its palletising is in no unit cost.')
  })

  it('shares by quantity when a product has no pallets, and says why', () => {
    const result = landedCost({
      currency: 'USD',
      lines: [
        { ...LINES[0], pallets: null, quantity: 300 },
        { ...LINES[1], invoiceId: 'a', quantity: 100 },
      ],
      invoices: [INVOICES[0]],
      local: {},
    })
    expect(result.lines.map((l) => l.parts.delivery)).toEqual([1875, 625])
    expect(result.notes).toContain('Not every product on EBGS000001 has its pallets, so its delivery is shared by quantity.')
  })

  it('shares an entry line for an invoice none of the products is on across all of them', () => {
    const local = costsFromBills([BILL])!.local
    const result = landedCost({ currency: 'USD', lines: [LINES[0]], invoices: [INVOICES[0]], local })
    expect(result.lines[0].parts.duty).toBe(3339)
    expect(result.notes.some((n) => n.includes('000002, which none of these products is on'))).toBe(true)
  })
})

describe('who sees what a shipment cost to land', () => {
  const caps = new Set(['transport.view', 'cost.view'] as const)

  it("takes cost.view and the shipment's own organisation, or Group", () => {
    const allowed = (organisations: string[], depot: string, capabilities: ReadonlySet<string> = caps) =>
      landedCostAllowed({ capabilities: capabilities as never, organisations: organisations as never }, depot)
    expect(allowed(['EB-USA'], 'US-BAL')).toBe(true)
    expect(allowed(['EB-GROUP'], 'CA-HAM')).toBe(true)
    expect(allowed(['EB-CANADA'], 'US-BAL')).toBe(false)
    // s.r.o. sees every container move, not what the depot paid to land it.
    expect(allowed(['EB-SRO'], 'US-BAL')).toBe(false)
    expect(allowed(['EB-USA'], 'US-BAL', new Set(['transport.view']))).toBe(false)
    expect(allowed(['EB-USA'], 'US-BAL', new Set(['cost.view']))).toBe(false)
  })

  it("is worked in the depot's own currency", () => {
    expect(landedCurrency('US-BAL')).toBe('USD')
    expect(landedCurrency('US-SBD')).toBe('USD')
    expect(landedCurrency('CA-HAM')).toBe('CAD')
  })

  it('is asked by every action before it writes, and by both pages before they show it', () => {
    const read = (file: string) => readFileSync(join(process.cwd(), file), 'utf8')
    const actions = read('src/app/actions/transport/landed-cost.ts')
    const exported = actions.match(/^export async function \w+/gm) ?? []
    expect(exported.length).toBe(2)
    expect((actions.match(/await landedCostTarget\(/g) ?? []).length).toBe(exported.length)
    expect(read('src/lib/transport/landed-cost.server.ts')).toContain("auth.capabilities.has('cost.view')")
    expect(read('src/app/(dashboard)/transport/[spotId]/page.tsx')).toContain('landedCostAllowed(who, shipment.destinationDepot)')
    expect(read('src/app/(dashboard)/transport/[spotId]/hand-shipment-view.tsx')).toContain('landedCostAllowed(who, shipment.depot)')
  })
})
