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

/**
 * The other codes a purchase order carries in from_entity and to_entity.
 *
 * These are not depots, they are the companies and the outside parties the
 * chain runs through, and they were being printed raw on screens and in emails
 * exactly like the depot codes were. Names, not codes: nobody outside this
 * database knows what EB-SRO or SUPPLIER means, and half the people inside it
 * have to think.
 *
 * SUPPLIER is Bamida. The column is deliberately generic in the database (see
 * raise-manufacturing-po.ts) so a second manufacturer would not need a
 * migration, but there is only one today and "SUPPLIER" on a document tells
 * nobody anything.
 */
export const ENTITY_MAPPING: Record<string, string> = {
  'EB-GROUP': 'Echo Barrier Group',
  'EB-SRO': 'Echo Barrier s.r.o.',
  'EB-USA': 'Echo Barrier USA',
  'EB-CANADA': 'Echo Barrier Canada',
  SUPPLIER: 'Bamida',
  'CARGO-PARTNER': 'Cargo Partner',
}

/**
 * The people-facing name for anything that can sit in from_entity or to_entity:
 * a depot, one of our companies, or an outside party.
 *
 * Same contract as depotLabel. Never throws, and an unmapped code passes
 * through rather than becoming "Unknown", because a code somebody recognises
 * beats a word that tells them nothing.
 */
export function entityLabel(code: string | null | undefined, fallback = "—"): string {
  const trimmed = String(code ?? "").trim()
  if (!trimmed) return fallback
  return ENTITY_MAPPING[trimmed] ?? DEPOT_MAPPING[trimmed] ?? trimmed
}
