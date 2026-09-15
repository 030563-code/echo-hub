/**
 * Which offices' calls a person may see.
 *
 * Dean, 15 Sep 2026: the calls tab is "scoped to the rep's own region". A
 * person's region is already `profiles.pipeline_id`, the same field the Quotes
 * module scopes deals by and company search scopes companies by, so this is the
 * call-side twin of `teamsForPipeline()` in src/lib/pipeline-config.ts.
 *
 * The office strings are the ones the phone system sends in its payload
 * (`office: "France"`), not depot codes and not country codes, so they are
 * matched exactly as they arrive.
 *
 * FAILS CLOSED. A person with no pipeline sees no calls at all, rather than
 * every office's. That is the rule company search already follows, and the
 * reason is the same: a scoping bug that opens up is invisible, one that closes
 * down gets reported in a minute.
 */

export const OFFICES = ['UK', 'USA', 'France', 'Spain', 'Asia', 'ANZ'] as const
export type Office = (typeof OFFICES)[number]

export function isOffice(value: string): value is Office {
  return (OFFICES as readonly string[]).includes(value)
}

/**
 * What each handler calls its own office, mapped to one name.
 *
 * They do not agree, and there is no reason they should: the UK handler sends
 * "United Kingdom", France sends "France", the placeholder contacts carry "AUZ"
 * for Australia. Normalising here rather than making 18 workflows agree means a
 * new country can be added upstream without the Hub silently filing its calls
 * under nobody.
 */
const OFFICE_ALIASES: Readonly<Record<string, Office>> = {
  uk: 'UK',
  'united kingdom': 'UK',
  gb: 'UK',
  britain: 'UK',
  usa: 'USA',
  us: 'USA',
  'united states': 'USA',
  'united states of america': 'USA',
  america: 'USA',
  france: 'France',
  fr: 'France',
  spain: 'Spain',
  es: 'Spain',
  espana: 'Spain',
  asia: 'Asia',
  anz: 'ANZ',
  auz: 'ANZ',
  au: 'ANZ',
  australia: 'ANZ',
  'new zealand': 'ANZ',
  nz: 'ANZ',
  'australia and new zealand': 'ANZ',
}

/**
 * The office this call belongs to, or null when nobody has mapped it.
 *
 * Null is deliberate and visible: the call is stored with whatever the handler
 * sent, and it shows up for super admins, who can then add the alias. Guessing
 * would put a customer's call in front of the wrong region.
 */
export function normaliseOffice(raw: string | null | undefined): Office | null {
  const value = (raw ?? '').trim()
  if (value === '') return null
  if (isOffice(value)) return value
  return OFFICE_ALIASES[value.toLowerCase()] ?? null
}

/**
 * Pipeline id to the offices whose calls it covers.
 *
 * Ids are the live HubSpot pipelines, copied from TEAM_PIPELINE_MAP in
 * src/lib/pipeline-config.ts. Euro Sales is one pipeline over two offices
 * (France and Spain), which is why the value is a list. International covers
 * Asia only (Dean, 15 Sep 2026); ANZ belongs to the Australia pipeline.
 */
export const OFFICES_BY_PIPELINE: Readonly<Record<string, readonly Office[]>> = {
  'dfc85d9e-7eb9-4ade-a9cf-4e726cbcc9cc': ['USA'], // USA SALES
  '2cfa0ec9-937b-44dc-9ee7-146d8745ab33': ['UK'], // UK SALES NEW
  'd739df20-18b4-4e4b-b183-943038071da1': ['France', 'Spain'], // EURO SALES
  '14520121': ['ANZ'], // AUSTRALIA SALES
  '6f942aab-15a9-4cdb-a684-53e78b36c424': ['Asia'], // INTERNATIONAL SALES
}

/**
 * The offices this viewer may see.
 *
 * A super admin sees every office, the same exemption every other scoped read
 * in the Hub carries. Everyone else gets their pipeline's offices, and an
 * unknown or missing pipeline gets an empty list, which every caller must treat
 * as "show nothing" rather than "show everything".
 */
export function officesForViewer(
  pipelineId: string | null | undefined,
  isSuperAdmin: boolean,
): readonly Office[] {
  if (isSuperAdmin) return OFFICES
  const id = String(pipelineId ?? '').trim()
  if (id === '') return []
  return OFFICES_BY_PIPELINE[id] ?? []
}
