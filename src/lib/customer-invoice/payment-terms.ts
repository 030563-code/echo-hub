/**
 * Xero payment terms to a concrete due date.
 *
 * Xero stores a contact's sales term as {Day, Type} rather than a day count,
 * and three of the four types are month-relative, so "Day: 15" can mean the
 * 15th of next month rather than 15 days. Getting that wrong silently dates
 * invoices weeks out, so each type is handled explicitly.
 *
 * Pure and UTC-only: parsing 'YYYY-MM-DD' with the Date constructor in a
 * negative-offset timezone lands on the previous day, which would shift every
 * due date by one.
 */

export type XeroPaymentTermType =
  | 'DAYSAFTERBILLDATE'
  | 'DAYSAFTERBILLMONTH'
  | 'OFCURRENTMONTH'
  | 'OFFOLLOWINGMONTH'

export interface XeroPaymentTerms {
  day: number
  type: string
}

/** House default when Xero holds no term for the contact: 30 days from the
 *  invoice date (Dean, 2026-09-02). */
export const DEFAULT_PAYMENT_TERM_DAYS = 30

function toUTC(date: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date.trim())
  if (!m) return null
  const year = Number(m[1])
  const month = Number(m[2])
  const day = Number(m[3])
  const d = new Date(Date.UTC(year, month - 1, day))
  if (Number.isNaN(d.getTime())) return null
  // Date.UTC ROLLS OVER rather than failing: month 13 day 45 silently becomes a
  // real date the following year, so '2026-13-45' would yield a plausible and
  // completely wrong due date. Round-trip the components to reject it.
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return null
  return d
}

function fmt(d: Date): string {
  return d.toISOString().slice(0, 10)
}

/** Last calendar day of the month `d` falls in. */
function endOfMonth(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0))
}

/** The `day`-th of `monthOffset` months from `d`, clamped to that month's
 *  length so "the 31st" of a 30-day month does not roll into the next one. */
function dayOfMonth(d: Date, day: number, monthOffset: number): Date {
  const year = d.getUTCFullYear()
  const month = d.getUTCMonth() + monthOffset
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate()
  return new Date(Date.UTC(year, month, Math.min(Math.max(day, 1), lastDay)))
}

/**
 * The due date for an invoice dated `invoiceDate` under `terms`.
 * Returns null when the invoice date is unparseable; falls back to Net 30 when
 * the contact carries no usable term (which is common: Xero contacts routinely
 * have PaymentTerms absent entirely).
 */
export function dueDateFromTerms(invoiceDate: string, terms: XeroPaymentTerms | null): string | null {
  const base = toUTC(invoiceDate)
  if (!base) return null

  const day = terms ? Number(terms.day) : Number.NaN
  if (!terms || !Number.isFinite(day) || day < 0) {
    return fmt(new Date(base.getTime() + DEFAULT_PAYMENT_TERM_DAYS * 86_400_000))
  }

  switch (String(terms.type || '').toUpperCase() as XeroPaymentTermType) {
    case 'DAYSAFTERBILLDATE':
      return fmt(new Date(base.getTime() + day * 86_400_000))
    case 'DAYSAFTERBILLMONTH':
      return fmt(new Date(endOfMonth(base).getTime() + day * 86_400_000))
    case 'OFCURRENTMONTH':
      return fmt(dayOfMonth(base, day, 0))
    case 'OFFOLLOWINGMONTH':
      return fmt(dayOfMonth(base, day, 1))
    default:
      // An unrecognised type is not a reason to invent a date from a number
      // whose meaning we do not know. Fall back to the house default.
      return fmt(new Date(base.getTime() + DEFAULT_PAYMENT_TERM_DAYS * 86_400_000))
  }
}

/** Human label for the terms, FOR THE EDITOR. The parenthetical notes are
 *  diagnostics for us: they say why the house default is being used. Never
 *  print this on a customer's invoice, use customerPaymentTerms. */
export function describeTerms(terms: XeroPaymentTerms | null): string {
  if (!terms || !Number.isFinite(Number(terms.day))) return `Net ${DEFAULT_PAYMENT_TERM_DAYS} (no term set in Xero)`
  const day = Number(terms.day)
  switch (String(terms.type || '').toUpperCase() as XeroPaymentTermType) {
    case 'DAYSAFTERBILLDATE':
      return `Net ${day}`
    case 'DAYSAFTERBILLMONTH':
      return `${day} day(s) after the end of the invoice month`
    case 'OFCURRENTMONTH':
      return `The ${day}th of the invoice month`
    case 'OFFOLLOWINGMONTH':
      return `The ${day}th of the following month`
    default:
      return `Net ${DEFAULT_PAYMENT_TERM_DAYS} (unrecognised term in Xero)`
  }
}

/**
 * The same label with our diagnostics stripped, for the customer's invoice.
 *
 * describeTerms says "Net 30 (no term set in Xero)" so a reviewer knows the
 * house default is standing in for a missing Xero term. That note is for us.
 * On the document it reads as an apology, and it tells the customer about the
 * state of our accounting system, which is none of their business. The terms
 * are still Net 30 either way.
 *
 * Applied at RENDER, not only at capture, so a row snapshotted before this
 * existed prints correctly without a backfill.
 */
export function customerPaymentTerms(label: string | null | undefined): string | null {
  const trimmed = String(label ?? '').replace(/\s*\([^)]*\)\s*$/, '').trim()
  return trimmed === '' ? null : trimmed
}
