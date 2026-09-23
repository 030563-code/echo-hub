import { describe, expect, it } from 'vitest'
import {
  entryHmf,
  entryMpf,
  lineMpf,
  mpfLimitsFor,
  roundCents,
  usFiscalYear,
  wholeDollars,
} from '@/lib/customs/fees'
import { dutyRuleFor, originGroup, productClassOfHts } from '@/lib/customs/duty'
import { checkPackage, holdsDraftBack } from '@/lib/customs/checks'
import { checksChip } from '@/lib/customs/view'
import { estimateCustoms } from '@/lib/customs/estimate'
import { customsPackageSchema, type CustomsPackage } from '@/lib/customs/nippon-invoice'
import { PACKAGE_D0806, PACKAGE_D1518, PACKAGE_D8400 } from '../fixtures/customs/nippon-packages'

/**
 * Dean, 23 Sep 2026: "Make sure our calculations are right too on the %es."
 *
 * The three packages are real (the scans on the Xero bills). The Hub's arithmetic has to reproduce
 * every figure CBP printed on them, and has to object when one is changed.
 */

const parse = (raw: unknown): CustomsPackage => customsPackageSchema.parse(raw)
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T
const codes = (pkg: CustomsPackage) => checkPackage(pkg).checks.map((c) => c.code)

describe('CBP rounding and fees', () => {
  it('rounds half up to the cent, including the cases floating point gets wrong', () => {
    expect(roundCents(1.005)).toBe(1.01)
    expect(roundCents(71.64875)).toBe(71.65)
    expect(roundCents(73.8625)).toBe(73.86)
    expect(roundCents(193.3016)).toBe(193.3)
  })

  it('rounds an entered value to whole dollars, as column 36 does', () => {
    expect(wholeDollars(55803.42)).toBe(55803)
    expect(wholeDollars(1515.86)).toBe(1516)
    expect(wholeDollars(43026.42)).toBe(43026)
  })

  it('starts the fiscal year on 1 October', () => {
    expect(usFiscalYear('2026-09-30')).toBe(2026)
    expect(usFiscalYear('2026-10-01')).toBe(2027)
    expect(mpfLimitsFor('2026-09-30')).toMatchObject({ min: 33.58, max: 651.5 })
    expect(mpfLimitsFor('2026-10-01')).toMatchObject({ min: 34.58, max: 670.86 })
    expect(mpfLimitsFor('2027-10-01')).toBeNull()
  })

  it('charges 0.3464 per cent per line, then holds the entry between the minimum and the maximum', () => {
    expect(lineMpf(55803)).toBe(193.3)
    expect(lineMpf(1516)).toBe(5.25)
    expect(entryMpf([55803, 1516], '2026-08-13')).toMatchObject({ sum: 198.55, amount: 198.55, clamped: null })
    // A small entry pays the minimum, a large one the maximum.
    expect(entryMpf([2000], '2026-08-13')).toMatchObject({ sum: 6.93, amount: 33.58, clamped: 'min' })
    expect(entryMpf([250000], '2026-08-13')).toMatchObject({ sum: 866, amount: 651.5, clamped: 'max' })
    expect(entryMpf([250000], '2026-10-01')).toMatchObject({ amount: 670.86, clamped: 'max' })
  })

  it('charges the harbor fee line by line, each rounded to the cent', () => {
    expect(entryHmf([55803, 1516])).toBe(71.65)
    expect(entryHmf([25007, 18019])).toBe(53.78)
    expect(entryHmf([59090])).toBe(73.86)
    // A real March 2026 entry from the history import charged 81.38 where 0.125 per cent of its
    // total would be 81.39. These invented lines reproduce it: 50.00 and 31.38 per line.
    expect(entryHmf([40003, 25107])).toBe(81.38)
    // And the other way: per line, 1.255 rounds up twice to 2.52; on the total of 2,008 it is 2.51.
    expect(entryHmf([1004, 1004])).toBe(2.52)
  })

  it('knows the fiscal 2025 processing fee limits', () => {
    // Federal Register Vol. 89 No. 140, 22 Jul 2024: minimum 32.71, maximum 634.62.
    expect(entryMpf([2000], '2025-08-10')).toMatchObject({ amount: 32.71, clamped: 'min' })
    expect(entryMpf([250000], '2025-09-30')).toMatchObject({ amount: 634.62, clamped: 'max' })
  })

  it("shows how far the sheet's MPF formula was out: 0.464 per cent of the barrier cost", () => {
    // "Arrived 2026" row 31: =AC25*0.464/100. On D1518's barrier cost that is 251.14; CBP charged
    // 193.30 on the whole entered value (barrier cost plus palletising).
    expect(roundCents(54125.5 * 0.00464)).toBe(251.14)
    expect(lineMpf(54125.5 + 1677.92)).toBe(193.3)
  })
})

describe('the duty rules', () => {
  it('knows Slovakia is in the EU and the UK is not', () => {
    expect(originGroup('SK')).toBe('EU')
    expect(originGroup('GB')).toBe('GB')
    expect(originGroup('UK')).toBe('GB')
    expect(originGroup('Multi')).toBeNull()
  })

  it('reads what the goods are from the broker heading, not the Chapter 99 rows', () => {
    expect(productClassOfHts('3925.90.0000')).toBe('acoustic')
    expect(productClassOfHts('7610.90.0080')).toBe('aluminium_frame')
    expect(productClassOfHts('9903.05.39')).toBeNull()
  })

  it('moves EU acoustic goods from 15.3 to 10 per cent on 24 July 2026, and leaves UK goods at 15.3', () => {
    expect(dutyRuleFor('acoustic', 'EU', '2026-07-23')?.rate).toBe(0.153)
    expect(dutyRuleFor('acoustic', 'EU', '2026-07-24')?.rate).toBe(0.1)
    expect(dutyRuleFor('acoustic', 'GB', '2026-07-24')?.rate).toBe(0.153)
  })

  it('gives no rate rather than a guess where none is on file', () => {
    expect(dutyRuleFor('aluminium_frame', 'GB', '2026-08-13')).toBeNull()
    expect(dutyRuleFor('acoustic', 'EU', '2026-01-15')).toBeNull()
  })
})

describe('the estimate before the entry', () => {
  it("gets D1518's real duty and fees from the value booked with Cargo Partner, to within the palletising", () => {
    // SPOT 242167963 was booked at 54,125.50, the H9 alone. The entry added 1,677.92 of
    // palletising and the 1,515.86 cutting station, so the estimate is a little under.
    const result = estimateCustoms({ goodsValue: 54125.5, currency: 'USD', originCountry: 'SK', onDate: '2026-08-13' })
    expect(result).toMatchObject({ ok: true, estimate: { enteredValue: 54126, duty: 5412.6, mpf: 187.49, hmf: 67.66, total: 5667.75 } })
  })

  it('refuses to estimate in dollars from a value booked in euros or pounds', () => {
    expect(estimateCustoms({ goodsValue: 36898.13, currency: 'GBP', originCountry: 'GB', onDate: '2026-09-23' })).toMatchObject({ ok: false })
  })

  it('refuses to estimate where no rule is on file', () => {
    expect(estimateCustoms({ goodsValue: 50000, currency: 'USD', originCountry: 'SK', onDate: '2026-01-15' })).toMatchObject({ ok: false })
    expect(estimateCustoms({ goodsValue: 50000, currency: 'USD', originCountry: 'CN', onDate: '2026-09-23' })).toMatchObject({ ok: false })
  })
})

describe('three real packages add up', () => {
  it('D1518 (EU rate, 10 per cent): every figure reproduced, nothing to flag', () => {
    const result = checkPackage(parse(PACKAGE_D1518))
    expect(result.checks).toEqual([])
    expect(result.worst).toBe('ok')
    expect(result.lines.map((l) => [l.invoiceNumber, l.enteredValue, l.dutyStated, l.mpfRecomputed])).toEqual([
      ['EBGS202610039', 55803, 5580.3, 193.3],
      ['EBGS202610040', 1516, 151.6, 5.25],
    ])
    expect(result.lines.every((l) => l.expected?.rate === 0.1)).toBe(true)
    expect(result.mpf?.recomputed.amount).toBe(198.55)
    expect(result.hmf?.recomputed).toBe(71.65)
    expect(result.customsTotal).toEqual({ stated: 6002.1, recomputed: 6002.1 })
    expect(result.serviceCharges).toBe(400)
  })

  it('D0806 (Section 122, panels and frames in GBP): 15.3 and 55.7 per cent, nothing to flag', () => {
    const result = checkPackage(parse(PACKAGE_D0806))
    expect(result.checks).toEqual([])
    expect(result.lines.map((l) => [l.lineNo, l.dutyStated, l.expected?.rate])).toEqual([
      ['001', 3826.07, 0.153],
      ['002', 10036.58, 0.557],
    ])
    expect(result.customsTotal).toEqual({ stated: 14065.47, recomputed: 14065.47 })
    expect(result.serviceCharges).toBe(2495.19)
  })

  it('D8400 (Long Beach, EUR less freight): nothing to flag', () => {
    const result = checkPackage(parse(PACKAGE_D8400))
    expect(result.checks).toEqual([])
    expect(result.customsTotal).toEqual({ stated: 9319.32, recomputed: 9319.32 })
    expect(result.serviceCharges).toBe(185)
  })
})

describe('a changed figure is caught', () => {
  it('a duty amount one cent out', () => {
    const raw = clone(PACKAGE_D1518)
    raw.entry.lines[0].hts[0].amount = 5580.31
    expect(codes(parse(raw))).toContain('hts_amount')
  })

  it('a misread duty digit', () => {
    const raw = clone(PACKAGE_D1518)
    raw.entry.lines[0].hts[0].amount = 5530.3
    raw.entry.duty_total = 5681.9
    expect(codes(parse(raw))).toContain('hts_amount')
  })

  it('a line processing fee at the wrong rate', () => {
    const raw = clone(PACKAGE_D1518)
    raw.entry.lines[0].mpf = 258.93 // 0.464 per cent, the sheet's figure
    expect(codes(parse(raw))).toContain('line_mpf')
  })

  it('an entry processing fee or harbor fee that does not match', () => {
    const raw = clone(PACKAGE_D0806)
    raw.entry.mpf_total = 150.04
    raw.entry.hmf_total = 55.78
    expect(codes(parse(raw))).toEqual(expect.arrayContaining(['mpf_total', 'hmf_total', 'other_total']))
  })

  it('blocks 41 to 44 that do not add up', () => {
    const raw = clone(PACKAGE_D8400)
    raw.entry.total = 9391.32
    expect(codes(parse(raw))).toEqual(expect.arrayContaining(['entry_total', 'customs_charge']))
  })

  it('a Nippon invoice whose lines do not reach its total', () => {
    const raw = clone(PACKAGE_D1518)
    raw.invoice.total = 6420.1
    expect(codes(parse(raw))).toContain('invoice_total')
  })

  it('the old 15.3 per cent charged on an EU entry after 24 July', () => {
    const raw = clone(PACKAGE_D1518)
    // As if the broker had kept Section 122 and the 5.3 per cent base rate.
    raw.entry.lines[0].hts = [
      { code: '9903.03.01', description: 'SECTION 122 - 10% DUTY', rate: 0.1, rate_text: '10.00%', amount: 5580.3 },
      { code: '3925.90.0000', description: 'PLAST, BUILDERS WARE, OTHER', rate: 0.053, rate_text: '5.30%', amount: 2957.56 },
    ]
    raw.entry.duty_total = 8689.46
    raw.entry.total = 8959.66
    raw.invoice.charges[3].amount = 8959.66
    raw.invoice.total = 9359.66
    const result = checkPackage(parse(raw))
    expect(result.checks.map((c) => c.code)).toEqual(['unexpected_rate'])
    expect(result.checks[0].message).toMatch(/15\.3% where 10% is expected/)
    expect(result.worst).toBe('warn')
  })

  describe('goods already at sea on 24 July 2026 (9903.05.85)', () => {
    // As if line 001 had been loaded before the new duty: the exemption heading at FREE and the
    // 5.3 per cent base rate only. CSMS 69326983 allows it for entries before 12:01 a.m. on 28 Jul.
    const inTransit = (entryDate: string) => {
      const raw = clone(PACKAGE_D1518)
      raw.entry.entry_date = entryDate
      raw.entry.lines[0].hts = [
        { code: '9903.05.85', description: 'IN TRANSIT', rate: 0, rate_text: 'FREE', amount: 0 },
        { code: '3925.90.0000', description: 'PLAST, BUILDERS WARE, OTHER', rate: 0.053, rate_text: '5.30%', amount: 2957.56 },
      ]
      raw.entry.duty_total = 3109.16
      raw.entry.total = 3379.36
      raw.invoice.charges[3].amount = 3379.36
      raw.invoice.total = 3779.36
      return checkPackage(parse(raw))
    }

    it('accepts the base rate when the entry is inside the window', () => {
      expect(inTransit('2026-07-27').checks).toEqual([])
    })

    it('says the exemption was claimed too late when the entry is dated 28 July', () => {
      const result = inTransit('2026-07-28')
      expect(result.checks.map((c) => c.code)).toEqual(['unexpected_rate'])
      expect(result.checks[0].message).toMatch(/Nippon filed 9903\.05\.85/)
      expect(result.checks[0].message).toMatch(/this entry is dated 28 Jul 2026; at 10% the duty would be \$5,580\.30/)
    })
  })

  it('an entered value that was not built the way the continuation sheet says', () => {
    const raw = clone(PACKAGE_D8400)
    raw.entry.value_builds[0].deductions = []
    expect(codes(parse(raw))).toEqual(['value_build'])
  })

  it('lines that do not add up to the value their invoice was built to', () => {
    const raw = clone(PACKAGE_D0806)
    raw.entry.lines[1].entered_value = 18119
    raw.entry.total_entered_value = 43126
    expect(codes(parse(raw))).toContain('value_build')
  })

  it('does not mind which printed figure the reading calls the dollar value', () => {
    // On two history bills Claude put the invoice value where the E.V. goes. The build still
    // arrives at what the line was entered at, so nothing is wrong with the entry.
    const raw = clone(PACKAGE_D8400)
    const build = raw.entry.value_builds[0]
    build.usd_value = build.invoice_value
    expect(codes(parse(raw))).toEqual([])
  })

  it('allows block 39 a dollar for every line after the first', () => {
    // Each line is rounded to the dollar and block 39 is the total rounded once.
    const near = clone(PACKAGE_D0806)
    near.entry.total_entered_value = 43027
    expect(codes(parse(near))).toEqual([])
    const far = clone(PACKAGE_D0806)
    far.entry.total_entered_value = 43028
    expect(codes(parse(far))).toEqual(['entered_value_total'])
  })

  it('a package with no entry summary cannot pass', () => {
    const raw = clone(PACKAGE_D1518) as Record<string, unknown>
    raw.entry = null
    const result = checkPackage(parse(raw))
    expect(result.checks.map((c) => c.code)).toEqual(['no_entry'])
    expect(result.worst).toBe('error')
    // It is not a wrong sum, so it does not say so.
    expect(checksChip(result)?.label).toBe('Cannot be checked')
    expect(result.checks[0].message).toMatch(/\$6,002\.10 of duty and fees on the invoice cannot be checked/)
  })

  it("Claude's remarks do not change the status: the sums do", () => {
    const raw = clone(PACKAGE_D1518)
    raw.warnings = ['The invoice prints SHIPPED FROM as PRESOV,CY; the entry says SK.']
    const result = checkPackage(parse(raw))
    expect(result.checks).toEqual([])
    expect(result.worst).toBe('ok')
  })

  it('holds a draft back from Xero when the PDF is not an invoice or the sums fail', () => {
    expect(holdsDraftBack(parse(clone(PACKAGE_D1518)))).toBe(false)
    const notice = clone(PACKAGE_D1518) as Record<string, unknown>
    notice.is_invoice = false
    expect(holdsDraftBack(parse(notice))).toBe(true)
    const noEntry = clone(PACKAGE_D1518) as Record<string, unknown>
    noEntry.entry = null
    expect(holdsDraftBack(parse(noEntry))).toBe(true)
  })
})
