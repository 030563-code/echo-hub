import { entryHmf, entryMpf, lineMpf, roundCents, wholeDollars, type EntryMpf } from '@/lib/customs/fees'
import {
  DUTY_RULES,
  dutyRuleFor,
  isChapter99,
  originGroup,
  productClassOfHts,
  type DutyRule,
} from '@/lib/customs/duty'
import { customsChargeOf, serviceChargesOf, type CustomsPackage, type EntryLine } from '@/lib/customs/nippon-invoice'

/**
 * Every figure on a Nippon Express package, worked again from CBP's own rules.
 *
 * Claude reads the scan; this decides whether the reading adds up. An "error" is a figure that
 * does not agree with the arithmetic (a misread digit, or a real mistake on the entry). A "warn"
 * is something for Dave to look at: a rate that is not the one the law sets for that date, a
 * value that does not match how it was built, or a part of the scan Claude could not read.
 */

export type CheckLevel = 'ok' | 'warn' | 'error'

export interface CustomsCheck {
  level: Exclude<CheckLevel, 'ok'>
  code: string
  message: string
}

export interface LineRecalc {
  lineNo: string
  invoiceNumber: string | null
  enteredValue: number
  /** What the entry says the line's duty is, every heading added up. */
  dutyStated: number
  /** The same, worked from each heading's rate. */
  dutyRecomputed: number
  /** dutyStated over the entered value. */
  effectiveRate: number
  /** The rate the law sets for these goods on the entry date, when one is on file. */
  expected: DutyRule | null
  mpfStated: number | null
  mpfRecomputed: number
}

export interface PackageCheck {
  lines: LineRecalc[]
  mpf: { stated: number | null; recomputed: EntryMpf } | null
  hmf: { stated: number | null; recomputed: number } | null
  /** CBP's total (block 44) against duty plus fees worked out here. */
  customsTotal: { stated: number; recomputed: number } | null
  /** Nippon's "ESTIMATED CSTMS DUTY/FEES" line. */
  customsCharge: number | null
  /** Everything else on Nippon's invoice. */
  serviceCharges: number
  invoiceTotal: { stated: number; sum: number }
  checks: CustomsCheck[]
  worst: CheckLevel
}

const CENT = 0.005

const usd = (n: number) =>
  n.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 })
const pct = (rate: number) => `${roundCents(rate * 100).toFixed(2).replace(/\.?0+$/, '')}%`

function lineOrigin(line: EntryLine, entryOrigin: string | null): string | null {
  return line.origin ?? entryOrigin
}

export function checkPackage(pkg: CustomsPackage, rules: readonly DutyRule[] = DUTY_RULES): PackageCheck {
  const checks: CustomsCheck[] = []
  const invoice = pkg.invoice
  const customs = customsChargeOf(invoice)
  const service = roundCents(serviceChargesOf(invoice).reduce((sum, c) => sum + c.amount, 0))
  const chargeSum = roundCents(invoice.charges.reduce((sum, c) => sum + c.amount, 0))

  if (Math.abs(chargeSum - invoice.total) > CENT) {
    checks.push({
      level: 'error',
      code: 'invoice_total',
      message: `Nippon's charge lines add up to ${usd(chargeSum)}, but the invoice total says ${usd(invoice.total)}.`,
    })
  }
  if (!customs) {
    checks.push({
      level: 'warn',
      code: 'no_customs_charge',
      message: 'The invoice has no "Estimated customs duty/fees" line, so there is no duty on it to check.',
    })
  }

  const entry = pkg.entry
  if (!entry) {
    checks.push({
      level: customs ? 'error' : 'warn',
      code: 'no_entry',
      message: 'This PDF has no CBP entry summary, so the duty cannot be checked line by line.',
    })
    return finish({
      lines: [],
      mpf: null,
      hmf: null,
      customsTotal: null,
      customsCharge: customs?.amount ?? null,
      serviceCharges: service,
      invoiceTotal: { stated: invoice.total, sum: chargeSum },
      checks,
      warnings: pkg.warnings,
    })
  }

  const lines: LineRecalc[] = entry.lines.map((line) => {
    const ev = wholeDollars(line.entered_value)
    const dutyStated = roundCents(line.hts.reduce((sum, row) => sum + row.amount, 0))
    let dutyRecomputed = 0
    for (const row of line.hts) {
      if (row.rate == null) {
        dutyRecomputed += row.amount
        continue
      }
      const worked = roundCents(ev * row.rate)
      dutyRecomputed += worked
      if (Math.abs(worked - row.amount) > CENT) {
        checks.push({
          level: 'error',
          code: 'hts_amount',
          message: `Line ${line.line_no}: ${row.code} at ${pct(row.rate)} of ${usd(ev)} is ${usd(worked)}, the entry says ${usd(row.amount)}.`,
        })
      }
    }
    dutyRecomputed = roundCents(dutyRecomputed)

    const mpfRecomputed = lineMpf(ev)
    if (line.mpf != null && Math.abs(line.mpf - mpfRecomputed) > CENT) {
      checks.push({
        level: 'error',
        code: 'line_mpf',
        message: `Line ${line.line_no}: the processing fee at 0.3464% of ${usd(ev)} is ${usd(mpfRecomputed)}, the entry says ${usd(line.mpf)}.`,
      })
    }

    // The rate the law sets for these goods on this date. The goods are named by the line's
    // non-Chapter 99 heading; Chapter 99 rows are the extra duties on top.
    const goods = line.hts.find((row) => !isChapter99(row.code))
    const productClass = goods ? productClassOfHts(goods.code) : null
    const origin = originGroup(lineOrigin(line, entry.country_of_origin))
    const expected = productClass && origin ? dutyRuleFor(productClass, origin, entry.entry_date, rules) : null
    const effectiveRate = ev > 0 ? dutyStated / ev : 0
    if (expected && Math.abs(effectiveRate - expected.rate) > 0.0005) {
      checks.push({
        level: 'warn',
        code: 'unexpected_rate',
        message: `Line ${line.line_no} was charged ${pct(effectiveRate)} where ${pct(expected.rate)} is expected (${expected.basis}). Check with Nippon, or the rule is out of date.`,
      })
    }

    return {
      lineNo: line.line_no,
      invoiceNumber: line.invoice_number,
      enteredValue: ev,
      dutyStated,
      dutyRecomputed,
      effectiveRate,
      expected,
      mpfStated: line.mpf,
      mpfRecomputed,
    }
  })

  const evs = lines.map((l) => l.enteredValue)
  const evTotal = evs.reduce((sum, ev) => sum + ev, 0)
  if (Math.abs(evTotal - wholeDollars(entry.total_entered_value)) > 0.5) {
    checks.push({
      level: 'error',
      code: 'entered_value_total',
      message: `The lines' entered values add up to ${usd(evTotal)}, block 39 says ${usd(entry.total_entered_value)}.`,
    })
  }

  const dutySum = roundCents(lines.reduce((sum, l) => sum + l.dutyStated, 0))
  if (Math.abs(dutySum - entry.duty_total) > CENT) {
    checks.push({
      level: 'error',
      code: 'duty_total',
      message: `The lines' duty adds up to ${usd(dutySum)}, block 41 says ${usd(entry.duty_total)}.`,
    })
  }

  const mpf = entryMpf(evs, entry.entry_date)
  if (!mpf.limits) {
    checks.push({
      level: 'warn',
      code: 'mpf_limits_unknown',
      message: `No processing fee minimum and maximum are on file for the fiscal year of ${entry.entry_date}. Add CBP's figures to src/lib/customs/fees.ts.`,
    })
  }
  if (entry.mpf_total != null && Math.abs(entry.mpf_total - mpf.amount) > CENT) {
    checks.push({
      level: 'error',
      code: 'mpf_total',
      message: `The processing fee should be ${usd(mpf.amount)}${mpf.clamped ? ` (the year's ${mpf.clamped === 'min' ? 'minimum' : 'maximum'})` : ''}, the entry says ${usd(entry.mpf_total)}.`,
    })
  }

  const hmf = entryHmf(evs)
  if (entry.hmf_total != null && Math.abs(entry.hmf_total - hmf) > CENT) {
    checks.push({
      level: 'error',
      code: 'hmf_total',
      message: `The harbor fee at 0.125% of ${usd(evTotal)} is ${usd(hmf)}, the entry says ${usd(entry.hmf_total)}.`,
    })
  }

  const feesStated = roundCents((entry.mpf_total ?? mpf.amount) + (entry.hmf_total ?? 0))
  if (Math.abs(feesStated - entry.other_total) > CENT) {
    checks.push({
      level: 'error',
      code: 'other_total',
      message: `The processing and harbor fees add up to ${usd(feesStated)}, block 43 says ${usd(entry.other_total)}.`,
    })
  }
  const blockSum = roundCents(entry.duty_total + entry.tax_total + entry.other_total)
  if (Math.abs(blockSum - entry.total) > CENT) {
    checks.push({
      level: 'error',
      code: 'entry_total',
      message: `Duty, tax and other add up to ${usd(blockSum)}, block 44 says ${usd(entry.total)}.`,
    })
  }
  const recomputedTotal = roundCents(
    lines.reduce((sum, l) => sum + l.dutyRecomputed, 0) + mpf.amount + (entry.hmf_total != null ? hmf : 0),
  )
  if (customs && Math.abs(customs.amount - entry.total) > CENT) {
    checks.push({
      level: 'error',
      code: 'customs_charge',
      message: `Nippon billed ${usd(customs.amount)} for duty and fees, the entry totals ${usd(entry.total)}.`,
    })
  }

  // How each invoice's entered value was built: invoice value, plus the palletising, less any
  // freight in the price, at CBP's exchange rate.
  for (const build of entry.value_builds) {
    const its = entry.lines.filter((l) => build.invoice_number && l.invoice_number === build.invoice_number)
    if (build.invoice_value != null && build.fx_rate != null && build.usd_value != null) {
      const deductions = build.deductions.reduce((sum, d) => sum + d.amount, 0)
      const worked = roundCents((build.invoice_value + (build.added_value ?? 0) - deductions) * build.fx_rate)
      if (Math.abs(worked - build.usd_value) > 0.02) {
        checks.push({
          level: 'warn',
          code: 'value_build',
          message: `${build.invoice_number ?? 'An invoice'}: ${build.currency ?? ''} ${build.invoice_value} plus ${build.added_value ?? 0} less ${deductions} at ${build.fx_rate} is ${usd(worked)}, the entry says ${usd(build.usd_value)}.`,
        })
      }
    }
    if (its.length && build.usd_value != null) {
      const linesTotal = its.reduce((sum, l) => sum + wholeDollars(l.entered_value), 0)
      // Each line is rounded to the dollar on its own, so allow a dollar a line.
      if (Math.abs(linesTotal - build.usd_value) > its.length) {
        checks.push({
          level: 'warn',
          code: 'value_build_lines',
          message: `${build.invoice_number}: the lines' entered values add up to ${usd(linesTotal)}, the value was built as ${usd(build.usd_value)}.`,
        })
      }
    }
  }

  return finish({
    lines,
    mpf: { stated: entry.mpf_total, recomputed: mpf },
    hmf: { stated: entry.hmf_total, recomputed: hmf },
    customsTotal: { stated: entry.total, recomputed: recomputedTotal },
    customsCharge: customs?.amount ?? null,
    serviceCharges: service,
    invoiceTotal: { stated: invoice.total, sum: chargeSum },
    checks,
    warnings: pkg.warnings,
  })
}

/** Claude's own doubts count as things to look at. Linking the shipment is reported by the
 *  match, not here: a package with no waybill still matches on its master bill. */
function finish(input: Omit<PackageCheck, 'worst'> & { warnings: string[] }): PackageCheck {
  const { warnings, ...result } = input
  for (const w of warnings) {
    result.checks.push({ level: 'warn', code: 'ocr_warning', message: `Claude could not read everything: ${w}` })
  }
  const worst: CheckLevel = result.checks.some((c) => c.level === 'error')
    ? 'error'
    : result.checks.length
      ? 'warn'
      : 'ok'
  return { ...result, worst }
}
