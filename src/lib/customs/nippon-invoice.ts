import { z } from 'zod'

/**
 * What Claude reads off a Nippon Express customs invoice package, and the only shape the Hub
 * accepts from the OCR step.
 *
 * Every package read on 23 Sep 2026 held the same four documents, in scans with no text layer:
 *
 *  1. Nippon Express's own invoice (INVOICE, OCEAN COMMERCIAL IMPORT): number, date, the office
 *     (Edison NJ for Baltimore and Norfolk, Long Beach CA for San Bernardino), bills of lading,
 *     vessel, what was delivered where, and the charge lines, the first of which is "ESTIMATED
 *     CSTMS DUTY/FEES".
 *  2. The CBP entry summary (Form 7501), with the continuation sheet: one line per Group invoice
 *     (EBGS202610039, EBUK2026095), each with its HTS rows, rates, duty, entered value and MPF,
 *     and the harbor fee on the entry's total.
 *  3. The carrier's arrival notice or delivery order, sometimes exam charges and a PayCargo receipt.
 *  4. The Consoltainer Line sea waybill, which carries the SPOT ID. That is what ties an invoice to
 *     its shipment in Transport.
 *
 * Wire format is snake_case, the way n8n posts it. Rates are fractions (10.00% is 0.1, FREE is 0).
 * Money is a plain number in the document's currency.
 */

const money = z.number().finite()
const text = z.string().trim().min(1)
const optionalText = z.string().trim().nullish().transform((v) => (v ? v : null))
const isoDate = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'a date must be YYYY-MM-DD')
const optionalIsoDate = isoDate.nullish().transform((v) => v ?? null)

export const chargeSchema = z.object({
  label: text,
  amount: money,
})

export const htsRowSchema = z.object({
  /** As printed, dots included: "9903.05.39", "3925.90.0000". */
  code: text,
  description: optionalText,
  /** A fraction; null when the row is not ad valorem. FREE is 0. */
  rate: z.number().min(0).max(5).nullish().transform((v) => (v == null ? null : v)),
  /** As printed: "10.00%", "FREE", "5.30%". */
  rate_text: optionalText,
  /** The duty on this row, 0 when FREE. */
  amount: money,
})

/**
 * How CBP built the entered value of one Group invoice, from the continuation sheet. One per
 * invoice, not per line: entry 510 4528804-3 prints one build (43,026.42) for two lines of
 * EBUK2026095, the panels and the frames.
 */
export const valueBuildSchema = z.object({
  invoice_number: optionalText,
  /** I.V.: the invoice value, in the invoice's currency. */
  invoice_value: money.nullish().transform((v) => v ?? null),
  currency: optionalText,
  /** CBP's rate for the invoice currency ("USD @ 1.000000", "GBP @ 1.333100"). */
  fx_rate: z.number().positive().nullish().transform((v) => v ?? null),
  /** M/V: value added, the palletising, in the invoice's currency. */
  added_value: money.nullish().transform((v) => v ?? null),
  /** Anything taken off, "- Frt Chg 5097.00". */
  deductions: z.array(chargeSchema).default([]),
  /** The result in dollars before rounding (E.V. 55803.42). */
  usd_value: money.nullish().transform((v) => v ?? null),
})

export const entryLineSchema = z.object({
  line_no: text,
  /** The line's own origin when printed ("O SK", "O GB"), else null. */
  origin: optionalText,
  /** The Group invoice the line covers: "EBGS202610039", "EBUK2026095". A line that continues
   *  the invoice above it carries the same number. */
  invoice_number: optionalText,
  invoice_date: optionalText,
  description: optionalText,
  /** Column 36A: the entered value, whole dollars. */
  entered_value: money,
  /** Column 36B, "C 5413": the charges (freight) left out of the value. */
  charges: money.nullish().transform((v) => v ?? null),
  hts: z.array(htsRowSchema).min(1),
  /** The line's Merchandise Processing Fee. */
  mpf: money.nullish().transform((v) => v ?? null),
})

export const entrySchema = z.object({
  /** Block 1, "510 4540538-1". */
  entry_number: text,
  entry_type: optionalText,
  summary_date: optionalIsoDate,
  entry_date: isoDate,
  port_code: optionalText,
  import_date: optionalIsoDate,
  country_of_origin: optionalText,
  exporting_country: optionalText,
  manufacturer_id: optionalText,
  bl_number: optionalText,
  importing_carrier: optionalText,
  /** Block 39. */
  total_entered_value: money,
  /** Blocks 41 to 44. */
  duty_total: money,
  tax_total: money.default(0),
  other_total: money.default(0),
  total: money,
  /** Other fee summary: 499 M.P.F. and 501 Harbor. */
  mpf_total: money.nullish().transform((v) => v ?? null),
  hmf_total: money.nullish().transform((v) => v ?? null),
  lines: z.array(entryLineSchema).min(1),
  value_builds: z.array(valueBuildSchema).default([]),
})

export const nipponInvoiceSchema = z.object({
  invoice_number: text,
  invoice_date: isoDate,
  /** The issuing office's address as printed, which says New York or Long Beach. */
  office: optionalText,
  total: money,
  currency: z.string().trim().default('USD'),
  bl_house: optionalText,
  bl_master: optionalText,
  reference: optionalText,
  vessel: optionalText,
  packages: optionalText,
  arrival_date: optionalIsoDate,
  weight_kg: z.number().nonnegative().nullish().transform((v) => v ?? null),
  volume_m3: z.number().nonnegative().nullish().transform((v) => v ?? null),
  commodity: optionalText,
  shipper: optionalText,
  shipped_from: optionalText,
  delivered_to: optionalText,
  note: optionalText,
  charges: z.array(chargeSchema).min(1),
})

export const waybillSchema = z.object({
  spot_id: z
    .string()
    .trim()
    .regex(/^\d{6,12}$/, 'a SPOT ID is digits')
    .nullish()
    .transform((v) => v ?? null),
  hbl: optionalText,
  container_numbers: z.array(text).default([]),
})

export const customsPackageSchema = z.object({
  invoice: nipponInvoiceSchema,
  /** Null only when the package really has no entry summary; the checks say so. */
  entry: entrySchema.nullish().transform((v) => v ?? null),
  waybill: waybillSchema.nullish().transform((v) => v ?? { spot_id: null, hbl: null, container_numbers: [] }),
  other_documents: z.array(z.object({ kind: text, summary: optionalText })).default([]),
  /** Claude's remarks, in its own words: shown beside the bill, never counted as a check. */
  warnings: z.array(z.string()).default([]),
  /** False when the PDF is not a Nippon Express invoice at all (an arrival notice, a statement).
   *  Missing on readings made before 23 Sep 2026, which were all invoices. */
  is_invoice: z.boolean().optional(),
})

export type CustomsCharge = z.infer<typeof chargeSchema>
export type HtsRow = z.infer<typeof htsRowSchema>
export type EntryLine = z.infer<typeof entryLineSchema>
export type EntrySummary = z.infer<typeof entrySchema>
export type NipponInvoice = z.infer<typeof nipponInvoiceSchema>
export type CustomsPackage = z.infer<typeof customsPackageSchema>

/** The charge line that carries CBP's figure, "ESTIMATED CSTMS DUTY/FEES". */
export function customsChargeOf(invoice: NipponInvoice): CustomsCharge | null {
  return invoice.charges.find((c) => /cstms|customs|duty/i.test(c.label)) ?? null
}

/** Nippon's own charges: everything on its invoice that is not CBP's duty and fees. */
export function serviceChargesOf(invoice: NipponInvoice): CustomsCharge[] {
  const customs = customsChargeOf(invoice)
  return invoice.charges.filter((c) => c !== customs)
}

/** Initials Nippon prints that stay in capitals once its label is written normally. */
const ACRONYMS = new Set(['ISF', 'CBP', 'MPF', 'HMF', 'AMS', 'US', 'USA'])

/** A charge label for a person: Nippon's "ISF FILING CHARGE" as "ISF filing charge". */
export function chargeLabel(label: string): string {
  const lower = label.toLowerCase()
  const sentence = lower.charAt(0).toUpperCase() + lower.slice(1)
  return sentence.replace(/[a-z]+/gi, (word) => (ACRONYMS.has(word.toUpperCase()) ? word.toUpperCase() : word))
}
