/**
 * US customs user fees on a formal entry: the Merchandise Processing Fee (MPF) and the Harbor
 * Maintenance Fee (HMF), and the rounding CBP uses on the entry summary (CBP Form 7501).
 *
 * Pure, so the Customs tab, the shipment page's estimate and the unit tests read the same numbers.
 *
 * Dean, 23 Sep 2026: "there's also another I think 0.34% rate somewhere" and "Make sure our
 * calculations are right too on the %es". The 0.34 per cent is the MPF, 0.3464 per cent. Dave's
 * sheet ("Arrived 2026") types it as 0.464 per cent, which overstated it by about a third, and
 * applied it to the barrier cost alone.
 *
 * Checked against three real entries (510 4540538-1, 510 4528804-3, 510 4507079-7): CBP rounds the
 * entered value of each line to whole dollars (column 36 shows 55803 for 55,803.42), works every
 * fee and duty on that, rounds each amount half up to the cent, and charges the HMF once on the
 * entry's total entered value.
 *
 * Sources:
 *  - Rates: https://www.cbp.gov/trade/basic-import-export/user-fee-table (MPF 0.3464 per cent ad
 *    valorem; HMF 0.125 per cent ad valorem, ocean ports).
 *  - FY2026 limits: CBP Dec. 25-10, Federal Register 23 Jul 2025 (2025-13869).
 *  - FY2027 limits: Federal Register Vol. 91 No. 146, 31 Jul 2026 (2026-15530), footnote 9: "Only
 *    the limitation is increasing; the ad valorem rate of 0.3464 percent remains the same."
 */

export const MPF_RATE = 0.003464
export const HMF_RATE = 0.00125

export interface MpfLimits {
  /** The US federal fiscal year, which starts on 1 October of the year before. */
  fiscalYear: number
  min: number
  max: number
  source: string
}

/** Add the next year's row when CBP publishes it each summer; an entry with no row says so. */
export const MPF_LIMITS: readonly MpfLimits[] = [
  { fiscalYear: 2026, min: 33.58, max: 651.5, source: 'CBP Dec. 25-10, Federal Register 23 Jul 2025' },
  { fiscalYear: 2027, min: 34.58, max: 670.86, source: 'Federal Register Vol. 91 No. 146, 31 Jul 2026' },
]

/** Half up to the cent. toFixed first, so 100.49999999999999 (from 1.005 * 100) counts as .5. */
export function roundCents(value: number): number {
  return Math.round(Number((value * 100).toFixed(6))) / 100
}

/** CBP's entered value for a line: whole dollars, half up. */
export function wholeDollars(value: number): number {
  return Math.round(Number(value.toFixed(6)))
}

/** 2026-09-30 is FY2026, 2026-10-01 is FY2027. */
export function usFiscalYear(isoDate: string): number {
  const [y, m] = isoDate.slice(0, 10).split('-').map(Number)
  return m >= 10 ? y + 1 : y
}

export function mpfLimitsFor(isoDate: string): MpfLimits | null {
  const fy = usFiscalYear(isoDate)
  return MPF_LIMITS.find((l) => l.fiscalYear === fy) ?? null
}

/** The MPF on one line, before the entry's minimum and maximum. */
export function lineMpf(enteredValue: number): number {
  return roundCents(wholeDollars(enteredValue) * MPF_RATE)
}

export interface EntryMpf {
  /** What the lines add up to. */
  sum: number
  /** What the entry pays: the sum held between that year's minimum and maximum. */
  amount: number
  clamped: 'min' | 'max' | null
  limits: MpfLimits | null
}

/** The entry's MPF: every line's MPF, then the fiscal year's minimum and maximum on the total. */
export function entryMpf(lineEnteredValues: readonly number[], entryDate: string): EntryMpf {
  const sum = roundCents(lineEnteredValues.reduce((total, ev) => total + lineMpf(ev), 0))
  const limits = mpfLimitsFor(entryDate)
  if (!limits) return { sum, amount: sum, clamped: null, limits: null }
  if (sum < limits.min) return { sum, amount: limits.min, clamped: 'min', limits }
  if (sum > limits.max) return { sum, amount: limits.max, clamped: 'max', limits }
  return { sum, amount: sum, clamped: null, limits }
}

/** The HMF, once per entry, on the total of the lines' whole-dollar entered values. */
export function entryHmf(lineEnteredValues: readonly number[]): number {
  const total = lineEnteredValues.reduce((sum, ev) => sum + wholeDollars(ev), 0)
  return roundCents(total * HMF_RATE)
}
