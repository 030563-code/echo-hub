export const DEPOT_MAPPING: Record<string, string> = {
  'US-BAL': 'US Baltimore',
  'US-SBD': 'US California',
  'CA-HAM': 'CA - Hamilton',
  'EU-SK': 'EU-Slovakia',
  'EU-FR': 'EU-France',
  'GB-BSE': 'GB-Bury St Edmunds',
  'AU-SYD': 'AU-Sydney'
}

/**
 * The rep-facing name for a depot code.
 *
 * Reps see raw codes today (US-BAL, CA-HAM) in the depot picker, the quote
 * summary, the change-stage dialog and the invoicing queue. The mapping to
 * read them already existed; it was only ever used for CRM writes.
 *
 * Never throws and never returns blank: an unmapped code passes through
 * unchanged, because a code the rep recognises beats the word "Unknown".
 */
export function depotLabel(code: string | null | undefined, fallback = "—"): string {
  const trimmed = String(code ?? "").trim()
  if (!trimmed) return fallback
  return DEPOT_MAPPING[trimmed] ?? trimmed
}
