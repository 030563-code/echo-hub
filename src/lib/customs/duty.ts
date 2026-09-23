/**
 * US import duty on Echo Barrier's goods: the rate CBP applies, by what the goods are, where they
 * were made, and the date they were entered.
 *
 * Dean, 23 Sep 2026: "duty tax should be 15.3% fixed atm". It was, for acoustic barriers, until
 * 23 Jul 2026: 5.3 per cent on 3925.90.0000 (plastic builders' ware) plus the 10 per cent Section
 * 122 duty. From 24 Jul 2026 goods of an EU member state pay a combined 10 per cent, and the entry
 * of 13 Aug 2026 (510 4540538-1) shows exactly that. Aluminium frames pay 55.7 per cent. A flat
 * figure goes wrong whenever the law moves, so the rate is a dated rule, and every Nippon Express
 * entry is checked against the rule for its date: an entry that disagrees is the first sign a rule
 * is out of date.
 *
 * Only rates with a source are here. A date or product with no rule gets no estimate rather than
 * a guess. The Section 122 rows start at the earliest entry read that shows them (1 May 2026);
 * reading the older bills will move that back.
 */

export type ProductClass = 'acoustic' | 'aluminium_frame'
export type OriginGroup = 'EU' | 'GB'

export interface DutyRule {
  productClass: ProductClass
  origin: OriginGroup
  /** Entry dates, inclusive. */
  from: string
  to: string | null
  /** The whole ad valorem rate on the entered value, every heading added up. */
  rate: number
  /** How that rate is made up, in words. */
  basis: string
  source: string
}

export const DUTY_RULES: readonly DutyRule[] = [
  {
    productClass: 'acoustic',
    origin: 'EU',
    from: '2026-07-24',
    to: null,
    rate: 0.1,
    basis: 'HTS 9903.05.39: a combined column 1 and Section 301 rate of 10% for EU goods whose column 1 rate is under 10% (3925.90.0000 is 5.3%)',
    source: 'CBP CSMS 69326983, 23 Jul 2026; entry 510 4540538-1, 13 Aug 2026',
  },
  {
    productClass: 'acoustic',
    origin: 'GB',
    from: '2026-07-24',
    to: null,
    rate: 0.153,
    basis: '3925.90.0000 at 5.3% plus HTS 9903.05.81, an additional 10% on goods of the United Kingdom',
    source: 'CBP CSMS 69326983, 23 Jul 2026',
  },
  {
    productClass: 'acoustic',
    origin: 'EU',
    from: '2026-05-01',
    to: '2026-07-23',
    rate: 0.153,
    basis: '3925.90.0000 at 5.3% plus Section 122 at 10% (9903.03.01)',
    source: 'entries 510 4507079-7 (1 May 2026) and 510 4528804-3 (7 Jul 2026)',
  },
  {
    productClass: 'acoustic',
    origin: 'GB',
    from: '2026-05-01',
    to: '2026-07-23',
    rate: 0.153,
    basis: '3925.90.0000 at 5.3% plus Section 122 at 10% (9903.03.01)',
    source: 'entry 510 4528804-3, 7 Jul 2026',
  },
  {
    productClass: 'aluminium_frame',
    origin: 'GB',
    from: '2026-05-01',
    to: '2026-07-23',
    rate: 0.557,
    basis: '7610.90.0080 at 5.7% plus Section 232 on aluminium derivatives at 50% (9903.82.02); excluded from Section 122 (9903.03.06)',
    source: 'entry 510 4528804-3, 7 Jul 2026',
  },
]

/**
 * Goods already at sea when a new duty began, which pay the rate before it. The broker claims one
 * by filing its heading at FREE; whether the goods were loaded in time cannot be seen on the entry,
 * but the entry date can.
 */
export interface TransitExemption {
  heading: string
  /** Loaded onto the vessel before this day. */
  loadedBefore: string
  /** Entered for consumption before 12:01 a.m. Eastern on this day. */
  enteredBefore: string
  source: string
}

export const TRANSIT_EXEMPTIONS: readonly TransitExemption[] = [
  {
    heading: '9903.05.85',
    loadedBefore: '2026-07-24',
    enteredBefore: '2026-07-28',
    source: 'CBP CSMS 69326983, 23 Jul 2026, "General Exemptions For All Economies"',
  },
]

/** The in-transit exemption a line claims, if it files one of the headings. */
export function transitExemptionOf(codes: readonly string[]): TransitExemption | null {
  return TRANSIT_EXEMPTIONS.find((e) => codes.some((c) => c.startsWith(e.heading))) ?? null
}

const EU_MEMBER_STATES = new Set([
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE',
  'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE',
])

/** "SK" is an EU member state; "GB" and "UK" are the United Kingdom. "Multi" is nothing. */
export function originGroup(country: string | null | undefined): OriginGroup | null {
  const code = String(country ?? '').trim().toUpperCase()
  if (code === 'GB' || code === 'UK') return 'GB'
  return EU_MEMBER_STATES.has(code) ? 'EU' : null
}

/** What the goods are, from the classification the broker used. */
export function productClassOfHts(code: string): ProductClass | null {
  const digits = code.replace(/\D/g, '')
  if (digits.startsWith('3925') || digits.startsWith('3926')) return 'acoustic'
  if (digits.startsWith('7610')) return 'aluminium_frame'
  return null
}

/** Chapter 99 headings are the extra duties (Section 122, 232, 301); they say nothing about what
 *  the goods are. */
export function isChapter99(code: string): boolean {
  return code.replace(/\D/g, '').startsWith('99')
}

export function dutyRuleFor(
  productClass: ProductClass,
  origin: OriginGroup,
  entryDate: string,
  rules: readonly DutyRule[] = DUTY_RULES,
): DutyRule | null {
  const day = entryDate.slice(0, 10)
  return (
    rules.find(
      (r) => r.productClass === productClass && r.origin === origin && r.from <= day && (r.to === null || day <= r.to),
    ) ?? null
  )
}
