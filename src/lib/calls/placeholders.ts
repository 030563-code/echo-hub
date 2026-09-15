import 'server-only'
import { hubspotFetch } from '@/lib/hubspot-client'
import type { Office } from './offices'

/**
 * The contacts the phone system created from a number and nothing else.
 *
 * Read live from HubSpot rather than from the Hub's own table, because they
 * predate it: contact creation has run since May 2026 and the call log only
 * started working on 15 September, so 220 of the 221 placeholders in the portal
 * have no call attached to them at all. A list built from calls would show one
 * row and look broken while the actual mess sat in the CRM.
 *
 * One search, server side, no scanning: HubSpot filters on the shape these
 * records have (`Unknown` / `Caller (…)`, no email).
 */

/** The country each placeholder carries, by office. The phone system writes its
 *  own label, not an ISO code, and Australia is stored as AUZ. */
const COUNTRY_BY_OFFICE: Record<Office, string[]> = {
  UK: ['UK'],
  USA: ['USA'],
  France: ['France'],
  Spain: ['Spain'],
  Asia: ['Asia'],
  ANZ: ['AUZ', 'ANZ'],
}

export interface PlaceholderContact {
  id: string
  phone: string | null
  country: string | null
  createdAt: string | null
  office: Office | null
  /** False when the stored phone is not a number, which happens for a withheld
   *  caller: the handler strips 'anonymous' to nothing and stores '+'. */
  actionable: boolean
}

function officeForCountry(country: string | null): Office | null {
  if (!country) return null
  for (const [office, values] of Object.entries(COUNTRY_BY_OFFICE)) {
    if (values.includes(country)) return office as Office
  }
  return null
}

export interface PlaceholderResult {
  contacts: PlaceholderContact[]
  total: number
  error?: string
}

export async function loadPlaceholderContacts(offices: readonly Office[]): Promise<PlaceholderResult> {
  if (offices.length === 0) return { contacts: [], total: 0 }

  try {
    const response = await hubspotFetch('https://api.hubapi.com/crm/v3/objects/contacts/search', {
      method: 'POST',
      body: JSON.stringify({
        filterGroups: [
          {
            filters: [
              { propertyName: 'firstname', operator: 'EQ', value: 'Unknown' },
              { propertyName: 'lastname', operator: 'CONTAINS_TOKEN', value: 'Caller*' },
              // A record with an email is somebody real, whatever they are
              // called. Never offer one of those up for merging away.
              { propertyName: 'email', operator: 'NOT_HAS_PROPERTY' },
            ],
          },
        ],
        properties: ['firstname', 'lastname', 'phone', 'country', 'createdate'],
        sorts: [{ propertyName: 'createdate', direction: 'DESCENDING' }],
        limit: 100,
      }),
    })

    if (!response.ok) {
      console.error('loadPlaceholderContacts failed', response.status)
      return { contacts: [], total: 0, error: 'HubSpot could not be searched right now.' }
    }

    const data = (await response.json()) as {
      total?: number
      results?: { id: string; properties: Record<string, string | null> }[]
    }

    const contacts = (data.results ?? []).map((r) => {
      const p = r.properties ?? {}
      const phone = (p.phone ?? '').trim()
      const digits = phone.replace(/\D/g, '')
      return {
        id: r.id,
        phone: phone === '' ? null : phone,
        country: p.country ?? null,
        createdAt: p.createdate ?? null,
        office: officeForCountry(p.country ?? null),
        actionable: digits.length >= 7,
      }
    })

    // Scoped the same way the calls are: a rep sees their own offices. A
    // placeholder whose country nobody has mapped is shown to nobody but a
    // super admin, who sees every office anyway.
    const mine = contacts.filter((c) => c.office !== null && offices.includes(c.office))

    return { contacts: mine, total: data.total ?? mine.length }
  } catch (error) {
    console.error('loadPlaceholderContacts threw', error instanceof Error ? error.message : error)
    return { contacts: [], total: 0, error: 'HubSpot could not be reached.' }
  }
}
