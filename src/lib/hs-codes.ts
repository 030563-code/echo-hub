// HS codes on commercial invoices: what counts as one, and which lines lack one.
//
// Dean, 14 Sep 2026: "the hs codes must be in the commercial invoice from sro to
// group and group to depots". An invoice cannot be issued while any line has a
// blank HS code; the codes themselves are entered by Juraj on /invoices/hs-codes.
//
// isValidHsCode is the same rule as the product_hs_codes_hs_code_format CHECK in
// supabase/migrations/20260914120000_hs_codes_canada_leg.sql:
//   digits, dots and single spaces only, starting and ending with a digit,
//   6 to 10 digits in all.
// So 3926.90, 3926 90 97 and 3926.90.9985 all pass. It checks format only; it
// cannot know whether a number is a real tariff heading.
//
// Pure (no 'server-only'): the draft editor and the HS codes screen use it too.

/** The format half of the CHECK, character for character. */
export const HS_CODE_PATTERN = '^[0-9]+([. ][0-9]+)*$'
export const HS_CODE_MIN_DIGITS = 6
export const HS_CODE_MAX_DIGITS = 10

const HS_CODE_RE = new RegExp(HS_CODE_PATTERN)

/** Trim, and collapse every run of whitespace to one space. */
export function normaliseHsCode(input: string | null | undefined): string {
  return (input ?? '').trim().replace(/\s+/g, ' ')
}

/** True when `code` passes the database CHECK as it stands. Normalise first. */
export function isValidHsCode(code: string): boolean {
  if (!HS_CODE_RE.test(code)) return false
  const digits = code.replace(/[^0-9]/g, '').length
  return digits >= HS_CODE_MIN_DIGITS && digits <= HS_CODE_MAX_DIGITS
}

/** The lines whose HS code is null or blank. */
export function missingHsCodeLines<T extends { hs_code: string | null | undefined }>(lines: readonly T[]): T[] {
  return lines.filter((l) => normaliseHsCode(l.hs_code) === '')
}

/**
 * The products behind some lines, named for people: "Echo Barrier H9 (EBH9NA)".
 * One entry per SKU and name, in line order.
 */
export function nameProducts(lines: readonly { sku: string; product_name: string | null }[]): string {
  const seen = new Set<string>()
  const names: string[] = []
  for (const l of lines) {
    const name = (l.product_name ?? '').trim()
    const label = name && name !== l.sku ? `${name} (${l.sku})` : l.sku
    if (seen.has(label)) continue
    seen.add(label)
    names.push(label)
  }
  return names.join(', ')
}

/**
 * The SKUs that sit on more than one line of an invoice: the parts of a split.
 *
 * A split composition rule (invoice_composition_rules, rule_type 'split') turns
 * one product into several lines that keep the parent's SKU, for example the CS
 * Enclosure frame and body. The HS codes tab holds one code per SKU per leg, so
 * it cannot tell those parts apart: their codes are typed on the draft itself.
 */
export function splitPartSkus(lines: readonly { sku: string }[]): Set<string> {
  const seen = new Set<string>()
  const repeated = new Set<string>()
  for (const l of lines) {
    const sku = l.sku.trim()
    // A line with no SKU yet (just added on the draft) is not a product at all.
    if (!sku) continue
    if (seen.has(sku)) repeated.add(sku)
    seen.add(sku)
  }
  return repeated
}

/**
 * The lines with no HS code, split by where the code has to come from:
 *  - onTab: one line per product, so a code saved on the HS codes tab fills it.
 *  - onDraft: split parts sharing a SKU, so each code is typed on the draft.
 * `lines` is the whole invoice, not only the missing lines, because a split part
 * is recognised by its SKU repeating across the invoice.
 */
export function missingHsCodesByCause<T extends { sku: string; hs_code: string | null | undefined }>(
  lines: readonly T[],
): { onTab: T[]; onDraft: T[] } {
  const parts = splitPartSkus(lines)
  const missing = missingHsCodeLines(lines)
  return {
    onTab: missing.filter((l) => !parts.has(l.sku.trim())),
    onDraft: missing.filter((l) => parts.has(l.sku.trim())),
  }
}

/** What to do about the missing codes, one sentence per cause. Empty when none are missing. */
export function missingHsCodeAdvice(
  lines: readonly { sku: string; product_name: string | null; hs_code: string | null | undefined }[],
): string {
  const { onTab, onDraft } = missingHsCodesByCause(lines)
  const sentences: string[] = []
  if (onTab.length) {
    sentences.push(`For ${nameProducts(onTab)}, set the code on the HS codes tab, then use Fill on this draft or regenerate.`)
  }
  if (onDraft.length) {
    sentences.push(
      `${nameProducts(onDraft)} ${onDraft.length === 1 ? 'is a part' : 'are parts'} split by a composition rule, which the HS codes tab cannot fill, so type ${onDraft.length === 1 ? 'its code' : 'each code'} on the draft with Edit.`,
    )
  }
  return sentences.join(' ')
}

/** Why an invoice cannot be issued yet, or null when every line has an HS code. */
export function issueBlockedReason(
  lines: readonly { sku: string; product_name: string | null; hs_code: string | null | undefined }[],
): string | null {
  const missing = missingHsCodeLines(lines)
  if (!missing.length) return null
  const count = missing.length === 1 ? '1 line has' : `${missing.length} lines have`
  return `This invoice cannot be issued: ${count} no HS code. ${missingHsCodeAdvice(lines)}`
}
