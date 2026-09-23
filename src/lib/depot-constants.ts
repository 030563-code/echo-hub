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
 * HubSpot's own spelling of each depot, keyed the other way round.
 *
 * The `sending_depot` deal property is an enumeration whose display LABEL is
 * the code (EU-FR) and whose internal VALUE is the long name (EU-France), for
 * all seven depots (read live from the property definition, 23 Sep 2026). So
 * DEPOT_MAPPING is also, exactly, code to HubSpot value, which is why
 * updateDealStage writes it to HubSpot. The EURO deal sync copies HubSpot's
 * value straight into deals_registry.depot_code, so 66 French deals read
 * 'EU-France' where the Hub says 'EU-FR'; the USA sync writes the code. A
 * record the Hub did not write can therefore carry either spelling, and it is
 * read back through depotCode() rather than compared to a code directly.
 */
const HUBSPOT_VALUE_TO_CODE: Record<string, string> = Object.fromEntries(
  Object.entries(DEPOT_MAPPING).map(([code, value]) => [value.toUpperCase(), code]),
)

/**
 * The depot code for whatever spelling a record holds: the code itself, or
 * HubSpot's internal value for it, in any case. null for anything else,
 * because a depot the Hub does not know has to be refused by name, not
 * passed along as if it were one.
 */
export function depotCode(value: string | null | undefined): string | null {
  const upper = String(value ?? '').trim().toUpperCase()
  if (!upper) return null
  if (upper in DEPOT_MAPPING) return upper
  return HUBSPOT_VALUE_TO_CODE[upper] ?? null
}

/**
 * Every spelling deals_registry.depot_code may hold for these depots: each
 * code and HubSpot's internal value for it. For an IN (...) that has to find
 * the French deals whichever sync wrote them.
 */
export function depotQueryValues(codes: readonly string[]): string[] {
  const out = new Set<string>()
  for (const code of codes) {
    out.add(code)
    if (code in DEPOT_MAPPING) out.add(DEPOT_MAPPING[code])
  }
  return [...out]
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
