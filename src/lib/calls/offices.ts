/**
 * The phone-system offices, and the names each handler sends for them.
 *
 * Which offices a person may see is an organisation question: the mapping
 * from organisation to offices lives in src/lib/organisations.ts
 * (officesForOrg), and the pages ask activeOrganisation() first. This file
 * only knows what an office IS.
 *
 * The office strings are the ones the phone system sends in its payload
 * (`office: "France"`), not depot codes and not country codes, so they are
 * matched exactly as they arrive.
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
