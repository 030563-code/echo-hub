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

/** Why an invoice cannot be issued yet, or null when every line has an HS code. */
export function issueBlockedReason(
  lines: readonly { sku: string; product_name: string | null; hs_code: string | null | undefined }[],
): string | null {
  const missing = missingHsCodeLines(lines)
  if (!missing.length) return null
  const count = missing.length === 1 ? '1 line has' : `${missing.length} lines have`
  return `This invoice cannot be issued: ${count} no HS code (${nameProducts(missing)}). Open the draft with Edit and type each code, or fill them from the HS codes tab.`
}
