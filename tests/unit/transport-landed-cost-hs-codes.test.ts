import { describe, expect, it } from 'vitest'
import { HMF_RATE, MPF_RATE, roundCents } from '@/lib/customs/fees'
import { customsPackageSchema } from '@/lib/customs/nippon-invoice'
import type { CompositionRule, HsCodeEntry } from '@/lib/invoice-composition'
import { landedLeg } from '@/lib/transport/cost-access'
import {
  costsFromBills,
  effectiveLocalCosts,
  hsSharesOf,
  landedCost,
  type CostInvoice,
  type CostLine,
  type EntryCharge,
  type LandedResult,
  type LocalCosts,
} from '@/lib/transport/landed-cost'

/**
 * Duty by HS code inside a Group invoice. Dean, 24 Sep 2026: on an invoice carrying barriers and a
 * compact cutting station, the frames' duty (7610.90.0080, 5.7% plus Section 232 at 50%) was being
 * shared by value, so part of it landed on the barriers.
 *
 * Every figure, number and product here is invented (the repository is public). The headings are
 * the published US tariff numbers the entries use.
 */

const PLASTIC = '3925.90.0000'
const FRAME = '7610.90.0080'
const HOOKS = '7326.90.8688'

// One invoice in dollars: 140 barriers on 2 pallets and 2 compact cutting stations on 1, with 300
// of palletising, so by value the barriers are 14,200 and the stations 4,100.
const MIXED: CostInvoice = { id: 'mixed', number: 'EBGS000021', currency: 'USD', rate: null, palletising: 300, delivery: 0, insurance: 0, otherAmount: 0 }
const BARRIERS: CostLine = {
  id: 'barriers',
  productCode: 'H9TEST',
  quantity: 140,
  pallets: 2,
  invoiceId: 'mixed',
  goodsAmount: 14000,
  hsCodes: [{ code: PLASTIC, share: 1 }],
}
// The station's frame and body, half its value each, as its split rule declares it.
const STATION: CostLine = {
  id: 'station',
  productCode: 'CSTEST',
  quantity: 2,
  pallets: 1,
  invoiceId: 'mixed',
  goodsAmount: 4000,
  hsCodes: [
    { code: FRAME, share: 0.5 },
    { code: PLASTIC, share: 0.5 },
  ],
}

/** An entry line, each row's duty worked the way CBP works it. */
function entryLine(no: string, ev: number, rows: [code: string, rate: number][], printsMpf = true) {
  return {
    line_no: no,
    invoice_number: MIXED.number,
    entered_value: ev,
    mpf: printsMpf ? roundCents(ev * MPF_RATE) : null,
    hts: rows.map(([code, rate]) => ({ code, rate, amount: roundCents(ev * rate) })),
  }
}

/** Nippon's bill around an entry, its totals added up from the lines. */
function billFor(lines: ReturnType<typeof entryLine>[]) {
  const duty = roundCents(lines.reduce((sum, l) => sum + l.hts.reduce((s, r) => s + r.amount, 0), 0))
  const mpf = roundCents(lines.reduce((sum, l) => sum + roundCents(l.entered_value * MPF_RATE), 0))
  const hmf = roundCents(lines.reduce((sum, l) => sum + roundCents(l.entered_value * HMF_RATE), 0))
  const customs = roundCents(duty + mpf + hmf)
  return customsPackageSchema.parse({
    invoice: {
      invoice_number: 'NEU-TEST-21',
      invoice_date: '2026-06-02',
      total: roundCents(customs + 150),
      charges: [
        { label: 'ESTIMATED CSTMS DUTY/FEES', amount: customs },
        { label: 'BROKERAGE ENTRY SERVICES', amount: 150 },
      ],
    },
    entry: {
      entry_number: '000 0000021-1',
      entry_date: '2026-06-01',
      total_entered_value: lines.reduce((sum, l) => sum + l.entered_value, 0),
      duty_total: duty,
      other_total: roundCents(mpf + hmf),
      total: customs,
      mpf_total: mpf,
      hmf_total: hmf,
      lines,
    },
  })
}

// The barriers and the stations' plastic bodies, with Section 122 on top: 1,600 + 848.
const BODY_LINE = entryLine('001', 16000, [
  ['9903.03.01', 0.1],
  [PLASTIC, 0.053],
])
// The stations' aluminium frames: excluded from Section 122, Section 232 at 50%, and 5.7%: 1,150 + 131.10.
const FRAME_LINE = entryLine('002', 2300, [
  ['9903.03.06', 0],
  ['9903.82.02', 0.5],
  [FRAME, 0.057],
])
const BILL = billFor([BODY_LINE, FRAME_LINE])

/** The landed cost from a bill, with whatever each product is entered under. */
function fromBill(bill: ReturnType<typeof billFor>, lines: CostLine[] = [BARRIERS, STATION]): LandedResult {
  const bills = costsFromBills([bill])!
  const { local, source } = effectiveLocalCosts({}, bills)
  return landedCost({ currency: 'USD', lines, invoices: [MIXED], local, entryLines: bills.entryLines, dutySource: source.duty })
}

/** The same, the way it was worked before the codes: nothing known about them. */
function byValueToday(bill: ReturnType<typeof billFor>): LandedResult {
  const bills = costsFromBills([bill])!
  const lines = [BARRIERS, STATION].map((line) => ({ ...line, hsCodes: undefined }))
  return landedCost({ currency: 'USD', lines, invoices: [MIXED], local: effectiveLocalCosts({}, bills).local })
}

const customsOf = (result: LandedResult) => result.lines.map((l) => ({ duty: l.parts.duty, mpf: l.parts.mpf, hmf: l.parts.hmf }))
const byCodeNotes = (result: LandedResult) => result.notes.filter((n) => n.includes('HS code'))

describe("the entry's lines, as the landed cost reads them", () => {
  it('keeps each line with its goods heading, its duty with the 9903 rows beside it, and its fee', () => {
    const bills = costsFromBills([BILL])!
    expect(bills.entryLines).toEqual([
      { invoiceNumber: 'EBGS000021', code: PLASTIC, duty: 2448, mpf: 55.42 },
      { invoiceNumber: 'EBGS000021', code: FRAME, duty: 1281.1, mpf: 7.97 },
    ])
    // The invoice's totals are what they always were.
    expect(bills.local.duty).toEqual({ total: 3729.1, byInvoice: [{ invoiceNumber: 'EBGS000021', amount: 3729.1 }] })
  })

  it('names no heading for a line with none outside Chapter 99, or with two', () => {
    const extraOnly = entryLine('002', 2300, [['9903.82.02', 0.5]])
    const twoGoods = entryLine('003', 1000, [
      [FRAME, 0.057],
      ['7616.99.5190', 0.025],
    ])
    const lines = costsFromBills([billFor([BODY_LINE, extraOnly, twoGoods])])!.entryLines
    expect(lines.map((l) => l.code)).toEqual([PLASTIC, null, null])
  })

  it('leaves the fee off a line that does not print one', () => {
    const lines = costsFromBills([billFor([BODY_LINE, entryLine('002', 2300, [[FRAME, 0.057]], false)])])!.entryLines
    expect(lines[0].mpf).not.toBeNull()
    expect(lines[1].mpf).toBeNull()
  })
})

describe('an invoice carrying barriers and a cutting station', () => {
  const result = fromBill(BILL)
  const [barriers, station] = result.lines

  it("puts the frame line's duty, Section 232 included, on the cutting station alone", () => {
    // 1,281.10 from the frame line, and its half of the body line's by value (see below).
    expect(station.parts.duty).toBe(1589.92)
    expect(roundCents(station.parts.duty - 308.82)).toBe(1281.1)
  })

  it("shares the body line's duty by value between the barriers and the station's body", () => {
    // 2,448 over 14,200 of barriers and 2,050 of station body (half of 4,100).
    expect(barriers.parts.duty).toBe(2139.18)
    expect(roundCents(barriers.parts.duty + 308.82)).toBe(2448)
    // By value across the invoice, the barriers carried 2,893.62 and the stations 835.48.
    expect(customsOf(byValueToday(BILL)).map((c) => c.duty)).toEqual([2893.62, 835.48])
  })

  it('does the same with the processing fee, which the entry gives line by line', () => {
    // 7.97 on the frames; 55.42 over 14,200 and 2,050.
    expect(station.parts.mpf).toBe(14.96)
    expect(barriers.parts.mpf).toBe(48.43)
  })

  it('keeps the harbour fee, given only in total, by value across the invoice', () => {
    expect(barriers.parts.hmf).toBe(17.75)
    expect(station.parts.hmf).toBe(5.13)
  })

  it('says which headings each duty came from, and nothing about a fallback', () => {
    expect(barriers.dutyCodes).toEqual([PLASTIC])
    expect(station.dutyCodes).toEqual([PLASTIC, FRAME])
    expect(byCodeNotes(result)).toEqual([])
  })

  it('still adds up to what the entry charged, to the cent', () => {
    expect(result.totals.duty).toBe(3729.1)
    expect(result.totals.mpf).toBe(63.39)
    expect(result.totals.hmf).toBe(22.88)
    expect(barriers.total).toBe(16505.36)
    expect(station.total).toBe(5760.01)
    // Goods 18,000, palletising 300, customs 3,815.37 and brokerage 150.
    expect(result.total).toBe(22265.37)
  })
})

describe('falling back to the split by value, and saying why', () => {
  const today = customsOf(byValueToday(BILL))

  it('when the customs were typed by hand', () => {
    const { local, source } = effectiveLocalCosts({ duty: 3729.1 }, null)
    const result = landedCost({ currency: 'USD', lines: [BARRIERS, STATION], invoices: [MIXED], local, dutySource: source.duty })
    expect(result.lines.map((l) => l.parts.duty)).toEqual([2893.62, 835.48])
    expect(result.lines.every((l) => l.dutyCodes.length === 0)).toBe(true)
    expect(byCodeNotes(result)).toEqual(['Duty typed by hand is shared by value, not by HS code.'])
  })

  it('but says nothing when every product is under one heading, since that is the same split', () => {
    const more: CostLine = { ...BARRIERS, id: 'more', productCode: 'H10TEST' }
    const { local, source } = effectiveLocalCosts({ duty: 3000 }, null)
    const result = landedCost({ currency: 'USD', lines: [BARRIERS, more], invoices: [MIXED], local, dutySource: source.duty })
    expect(byCodeNotes(result)).toEqual([])
  })

  it("when Nippon's bill has no entry summary", () => {
    const result = fromBill({ ...BILL, entry: null })
    expect(result.totals.duty).toBe(3815.37)
    expect(byCodeNotes(result)).toEqual(["Nippon's bill has no entry summary, so duty is shared by value, not by HS code."])
  })

  it('when an entry line carries no heading for its goods', () => {
    const uncoded = billFor([BODY_LINE, entryLine('002', 2300, [['9903.82.02', 0.5]])])
    const result = fromBill(uncoded)
    expect(customsOf(result)).toEqual(customsOf(byValueToday(uncoded)))
    expect(byCodeNotes(result)).toEqual([
      'Duty on EBGS000021 is shared by value, not by HS code: an entry line for it has no single HS code for the goods.',
    ])
  })

  it("when a line's heading matches no product on the invoice", () => {
    // Hooks on the entry that nobody listed on the shipment.
    const withHooks = billFor([BODY_LINE, FRAME_LINE, entryLine('003', 100, [['9903.82.02', 0.5], [HOOKS, 0.029]])])
    const result = fromBill(withHooks)
    expect(customsOf(result)).toEqual(customsOf(byValueToday(withHooks)))
    expect(result.totals.duty).toBe(roundCents(3729.1 + 50 + 2.9))
    expect(byCodeNotes(result)).toEqual([`Duty on EBGS000021 is shared by value, not by HS code: no product on it is entered under ${HOOKS}.`])
  })

  it('when a product on the invoice has no code', () => {
    const result = fromBill(BILL, [BARRIERS, { ...STATION, hsCodes: [] }])
    expect(customsOf(result)).toEqual(today)
    expect(byCodeNotes(result)).toEqual(['Duty on EBGS000021 is shared by value, not by HS code: CSTEST has no HS code.'])
  })

  it("when a product's code is not on the entry, since its value was entered under another heading", () => {
    const oneLine = billFor([entryLine('001', 18300, [['9903.03.01', 0.1], [PLASTIC, 0.053]])])
    const result = fromBill(oneLine)
    expect(customsOf(result)).toEqual(customsOf(byValueToday(oneLine)))
    expect(byCodeNotes(result)).toEqual([
      `Duty on EBGS000021 is shared by value, not by HS code: the entry has no ${FRAME} line for CSTEST.`,
    ])
  })

  it('and quietly, as before, when the codes were never looked up', () => {
    expect(customsOf(byValueToday(BILL))).toEqual(today)
    expect(byCodeNotes(byValueToday(BILL))).toEqual([])
  })

  it('for the processing fee alone when the entry gives it only in total, keeping duty by code', () => {
    const totalOnly = billFor([entryLine('001', 16000, [['9903.03.01', 0.1], [PLASTIC, 0.053]], false), entryLine('002', 2300, [['9903.03.06', 0], ['9903.82.02', 0.5], [FRAME, 0.057]], false)])
    const result = fromBill(totalOnly)
    expect(result.lines.map((l) => l.parts.duty)).toEqual([2139.18, 1589.92])
    expect(result.lines.map((l) => l.parts.mpf)).toEqual(customsOf(byValueToday(totalOnly)).map((c) => c.mpf))
    expect(byCodeNotes(result)).toEqual([])
  })
})

describe('the duty still adds up to the entry, to the cent', () => {
  // Three barriers and a station, a cent's worth of rounding in every split.
  const lines: CostLine[] = [
    { ...BARRIERS, id: 'a', productCode: 'H8TEST', pallets: 1, goodsAmount: 1000, invoiceId: 'odd' },
    { ...BARRIERS, id: 'b', productCode: 'H9TEST', pallets: 1, goodsAmount: 1000, invoiceId: 'odd' },
    { ...BARRIERS, id: 'c', productCode: 'H10TEST', pallets: 1, goodsAmount: 1000, invoiceId: 'odd' },
    { ...STATION, id: 's', pallets: 1, goodsAmount: 1000, invoiceId: 'odd' },
  ]
  const odd: CostInvoice = { ...MIXED, id: 'odd', number: 'EBGS000031', palletising: 0 }

  for (const total of [0.01, 0.05, 1000.01, 3729.1, 12345.67, 99999.99]) {
    it(`for ${total.toFixed(2)} of duty`, () => {
      const body = roundCents(total * 0.7)
      const entryLines: EntryCharge[] = [
        { invoiceNumber: 'EBGS000031', code: PLASTIC, duty: body, mpf: null },
        { invoiceNumber: 'EBGS000031', code: FRAME, duty: roundCents(total - body), mpf: null },
      ]
      const local: LocalCosts = { duty: { total, byInvoice: [{ invoiceNumber: 'EBGS000031', amount: total }] } }
      const result = landedCost({ currency: 'USD', lines, invoices: [odd], local, entryLines, dutySource: 'bill' })
      expect(roundCents(result.lines.reduce((sum, l) => sum + l.parts.duty, 0))).toBe(total)
      expect(result.totals.duty).toBe(total)
      // The frame line on the station alone: the barriers share only the body line.
      expect(roundCents(result.lines.slice(0, 3).reduce((sum, l) => sum + l.parts.duty, 0))).toBeLessThanOrEqual(body)
      expect(byCodeNotes(result)).toEqual([])
    })
  }

  it('with an invoice by code beside one by value', () => {
    const other: CostInvoice = { ...MIXED, id: 'other', number: 'EBGS000032' }
    const both: CostLine[] = [...lines, { ...BARRIERS, id: 'd', productCode: 'V2TEST', invoiceId: 'other', hsCodes: [] }]
    const entryLines: EntryCharge[] = [
      { invoiceNumber: 'EBGS000031', code: PLASTIC, duty: 700.01, mpf: null },
      { invoiceNumber: 'EBGS000031', code: FRAME, duty: 300.03, mpf: null },
      { invoiceNumber: 'EBGS000032', code: PLASTIC, duty: 555.55, mpf: null },
    ]
    const local: LocalCosts = {
      duty: {
        total: 1555.59,
        byInvoice: [
          { invoiceNumber: 'EBGS000031', amount: 1000.04 },
          { invoiceNumber: 'EBGS000032', amount: 555.55 },
        ],
      },
    }
    const result = landedCost({ currency: 'USD', lines: both, invoices: [odd, other], local, entryLines, dutySource: 'bill' })
    expect(roundCents(result.lines.slice(0, 4).reduce((sum, l) => sum + l.parts.duty, 0))).toBe(1000.04)
    expect(result.lines[4].parts.duty).toBe(555.55)
    expect(result.totals.duty).toBe(1555.59)
    expect(byCodeNotes(result)).toEqual(['Duty on EBGS000032 is shared by value, not by HS code: V2TEST has no HS code.'])
  })
})

describe('what a product is entered under', () => {
  const rules: CompositionRule[] = [
    {
      id: 'usa',
      active: true,
      country: null,
      leg: 'GROUP_TO_USA',
      rule_type: 'split',
      source_sku: 'STATION-SKU',
      config: {
        children: [
          { label: 'Frame', share: 0.5, hs_code: FRAME },
          { label: 'Body', share: 0.5, hs_code: PLASTIC },
        ],
      },
      priority: 100,
    },
    {
      id: 'sro',
      active: true,
      country: null,
      leg: 'SRO_TO_GROUP',
      rule_type: 'split',
      source_sku: 'STATION-SKU',
      config: {
        children: [
          { label: 'Frame', share: 0.5, hs_code: null },
          { label: 'Body', share: 0.5, hs_code: null },
        ],
      },
      priority: 100,
    },
  ]
  const hsCodes: HsCodeEntry[] = [
    { sku: 'BARRIER-SKU', leg: 'GROUP_TO_USA', hs_code: PLASTIC },
    { sku: 'OTHER-BARRIER-SKU', leg: 'GROUP_TO_USA', hs_code: PLASTIC },
    { sku: 'HOOK-SKU', leg: 'GROUP_TO_USA', hs_code: HOOKS },
  ]
  const usa = { leg: 'GROUP_TO_USA', country: null, rules, hsCodes }

  it("is its split rule's parts at their shares, as its commercial invoice carries them", () => {
    expect(hsSharesOf(['STATION-SKU'], usa)).toEqual([
      { code: FRAME, share: 0.5 },
      { code: PLASTIC, share: 0.5 },
    ])
    const weighted = rules.map((r) => ({ ...r, config: { children: [{ label: 'Frame', share: 3, hs_code: FRAME }, { label: 'Body', share: 1, hs_code: PLASTIC }] } }))
    expect(hsSharesOf(['STATION-SKU'], { ...usa, rules: weighted })).toEqual([
      { code: FRAME, share: 0.75 },
      { code: PLASTIC, share: 0.25 },
    ])
  })

  it("is otherwise its own code for the leg", () => {
    expect(hsSharesOf(['BARRIER-SKU'], usa)).toEqual([{ code: PLASTIC, share: 1 }])
  })

  it('is nothing when a part has no code, or there is no code at all', () => {
    expect(hsSharesOf(['STATION-SKU'], { ...usa, leg: 'SRO_TO_GROUP' })).toEqual([])
    expect(hsSharesOf(['UNCODED-SKU'], usa)).toEqual([])
    expect(hsSharesOf([], usa)).toEqual([])
  })

  it('ignores a rule that is switched off', () => {
    expect(hsSharesOf(['STATION-SKU'], { ...usa, rules: rules.map((r) => ({ ...r, active: false })) })).toEqual([])
  })

  it('takes one Xero item standing for two products only when they are entered alike', () => {
    expect(hsSharesOf(['BARRIER-SKU', 'OTHER-BARRIER-SKU'], usa)).toEqual([{ code: PLASTIC, share: 1 }])
    expect(hsSharesOf(['BARRIER-SKU', 'HOOK-SKU'], usa)).toEqual([])
  })
})

describe('the leg a depot is entered on', () => {
  it('is Group to USA or Group to Canada, and nothing elsewhere', () => {
    expect(landedLeg('US-BAL')).toBe('GROUP_TO_USA')
    expect(landedLeg('US-SBD')).toBe('GROUP_TO_USA')
    expect(landedLeg('CA-HAM')).toBe('GROUP_TO_CANADA')
    expect(landedLeg('EU-SK')).toBeNull()
    expect(landedLeg(null)).toBeNull()
  })
})
