import { checkPackage, type PackageCheck } from '@/lib/customs/checks'
import { customsPackageSchema, serviceChargesOf, type CustomsPackage } from '@/lib/customs/nippon-invoice'

/**
 * What the Customs tab says about one bill, in words Dave uses. Pure, so the list, the bill page
 * and the tests agree.
 */

export type Tone = 'green' | 'amber' | 'red' | 'grey' | 'blue'

export interface StatusChip {
  label: string
  tone: Tone
}

/** The columns of a customs_bills row the tab reads. */
export interface CustomsBillFacts {
  id: string
  source: 'email' | 'xero_history'
  ocr_status: 'pending' | 'requested' | 'done' | 'failed'
  ocr_error: string | null
  extraction: unknown
  invoice_number: string | null
  invoice_date: string | null
  invoice_total: number | null
  customs_total: number | null
  duplicate_of: string | null
  spot_id: string | null
  xero_invoice_id: string | null
  xero_status: string | null
  xero_error: string | null
  file_name: string
  created_at: string
  /** The checks Dave signed off, as checksFingerprint wrote them. Missing on rows read before 24 Sep 2026. */
  reviewed_checks?: string | null
}

export interface CustomsListRow {
  id: string
  invoiceNumber: string | null
  invoiceDate: string | null
  spotId: string | null
  container: string | null
  groupInvoices: string[]
  enteredValue: number | null
  customs: number | null
  service: number | null
  total: number | null
  reading: StatusChip
  checks: StatusChip | null
  xero: StatusChip
  /** Waiting for Dave: a draft in Xero he has not approved. */
  awaitingApproval: boolean
}

export function packageFrom(extraction: unknown): CustomsPackage | null {
  const parsed = customsPackageSchema.safeParse(extraction)
  return parsed.success ? parsed.data : null
}

export function readingChip(row: Pick<CustomsBillFacts, 'ocr_status'>): StatusChip {
  switch (row.ocr_status) {
    case 'done':
      return { label: 'Read', tone: 'green' }
    case 'failed':
      return { label: 'Could not be read', tone: 'red' }
    default:
      return { label: 'Being read', tone: 'grey' }
  }
}

/**
 * What a bill's checks said, in one string, so a sign-off can tell whether it still applies. The
 * messages carry the figures, so a corrected reading gives a different fingerprint even when the
 * same kind of check fails.
 */
export function checksFingerprint(check: PackageCheck): string {
  return check.checks
    .map((c) => `${c.level}:${c.code}:${c.message}`)
    .sort()
    .join('\n')
}

/** Dave's sign-off holds while the checks are the ones he looked at. */
export function isSignedOff(check: PackageCheck | null, reviewedChecks: string | null | undefined): boolean {
  return Boolean(check && check.worst !== 'ok' && reviewedChecks != null && reviewedChecks === checksFingerprint(check))
}

export function checksChip(check: PackageCheck | null, reviewedChecks?: string | null): StatusChip | null {
  if (!check) return null
  // Looked at and understood: no longer something to look at.
  if (isSignedOff(check, reviewedChecks)) return { label: 'Checked', tone: 'green' }
  // Duty on the invoice with no entry summary to test it against is not a wrong sum.
  if (check.checks.some((c) => c.level === 'error' && c.code === 'no_entry')) return { label: 'Cannot be checked', tone: 'red' }
  if (check.worst === 'error') return { label: 'Does not add up', tone: 'red' }
  if (check.worst === 'warn') return { label: 'Needs a look', tone: 'amber' }
  return { label: 'Adds up', tone: 'green' }
}

export function xeroChip(
  row: Pick<CustomsBillFacts, 'duplicate_of' | 'xero_status' | 'xero_invoice_id' | 'xero_error' | 'ocr_status'>,
  pkg: CustomsPackage | null = null,
): StatusChip {
  if (row.duplicate_of) return { label: 'A resend, not billed', tone: 'grey' }
  if (pkg?.is_invoice === false && !row.xero_invoice_id) return { label: 'Not a bill', tone: 'grey' }
  const status = (row.xero_status ?? '').toUpperCase()
  if (row.xero_invoice_id) {
    if (status === 'DRAFT' || status === 'SUBMITTED') return { label: 'Draft in Xero', tone: 'blue' }
    // Xero's own name for the tab an approved bill sits under.
    if (status === 'AUTHORISED') return { label: 'Awaiting payment', tone: 'green' }
    if (status === 'PAID') return { label: 'Paid', tone: 'green' }
    if (status === 'VOIDED' || status === 'DELETED') return { label: 'Voided in Xero', tone: 'red' }
    return { label: 'In Xero', tone: 'green' }
  }
  if (row.xero_error) return { label: 'Draft not made', tone: 'red' }
  if (row.ocr_status === 'done') return { label: 'Not in Xero yet', tone: 'amber' }
  return { label: 'Not in Xero yet', tone: 'grey' }
}

export function listRow(row: CustomsBillFacts): CustomsListRow {
  const pkg = row.ocr_status === 'done' ? packageFrom(row.extraction) : null
  const check = pkg ? checkPackage(pkg) : null
  const status = (row.xero_status ?? '').toUpperCase()
  return {
    id: row.id,
    invoiceNumber: row.invoice_number,
    invoiceDate: row.invoice_date,
    spotId: row.spot_id,
    container: pkg?.waybill.container_numbers[0] ?? null,
    groupInvoices: pkg?.entry ? [...new Set(pkg.entry.lines.map((l) => l.invoice_number).filter((n): n is string => Boolean(n)))] : [],
    enteredValue: pkg?.entry?.total_entered_value ?? null,
    customs: row.customs_total,
    service: pkg ? serviceChargesOf(pkg.invoice).reduce((sum, c) => Math.round((sum + c.amount) * 100) / 100, 0) : null,
    total: row.invoice_total,
    reading: readingChip(row),
    checks: checksChip(check, row.reviewed_checks),
    xero: xeroChip(row, pkg),
    awaitingApproval: Boolean(row.xero_invoice_id) && !row.duplicate_of && (status === 'DRAFT' || status === 'SUBMITTED'),
  }
}

export const TONE_CLASSES: Record<Tone, string> = {
  green: 'bg-emerald-50 text-emerald-800 ring-emerald-200',
  amber: 'bg-amber-50 text-amber-900 ring-amber-200',
  red: 'bg-red-50 text-red-800 ring-red-200',
  grey: 'bg-gray-50 text-gray-600 ring-gray-200',
  blue: 'bg-blue-50 text-blue-800 ring-blue-200',
}
