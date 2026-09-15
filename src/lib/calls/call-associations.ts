import 'server-only'

import { hubspotFetch } from '@/lib/hubspot-client'
import type { HubSpotFetcher } from './hubspot-contact'

/**
 * The associations HubSpot would have given a call had a rep logged it by hand.
 *
 * HubSpot's own rule, from its knowledge base: an activity logged on a contact
 * "will be automatically associated with the contact's primary company and the
 * five most recent associated open deals". That rule runs for calls made in
 * HubSpot and for HubSpot-built apps. The phone system creates its calls through
 * the API with the contact alone (association type 194), so they reached the
 * contact's timeline and never the company's or the deal's. Measured 15 Sep
 * 2026 on the newest 40 calls in the portal: 28 dialler calls, 21 with a
 * company and 12 with a deal; 6 phone-system calls, none with either.
 *
 * Best effort throughout. The merge is what matters; an association that fails
 * leaves the call exactly where the phone system left it.
 */

export interface AssociationRow {
  toObjectId: string | number
  associationTypes?: { category?: string; typeId?: number; label?: string | null }[]
}

/** HubSpot-defined association type 1: contact to PRIMARY company. */
const PRIMARY_COMPANY_TYPE = 1
/** HubSpot's own cap: the five most recent open deals. */
export const OPEN_DEAL_LIMIT = 5

/** The primary company among a contact's company associations, else the first. */
export function primaryCompanyId(rows: readonly AssociationRow[]): string | null {
  const flagged = rows.find((row) =>
    (row.associationTypes ?? []).some(
      (type) => type.category === 'HUBSPOT_DEFINED' && type.typeId === PRIMARY_COMPANY_TYPE,
    ),
  )
  const chosen = flagged ?? rows[0]
  return chosen ? String(chosen.toObjectId) : null
}

export interface DealRow {
  id: string | number
  properties?: { createdate?: string | null; hs_is_closed?: string | null }
}

/** Open deals, newest first, capped the way HubSpot caps its own rule. */
export function openDealIds(rows: readonly DealRow[], limit = OPEN_DEAL_LIMIT): string[] {
  return rows
    .filter((row) => String(row.properties?.hs_is_closed ?? 'false') !== 'true')
    .sort(
      (a, b) =>
        (Date.parse(b.properties?.createdate ?? '') || 0) - (Date.parse(a.properties?.createdate ?? '') || 0),
    )
    .slice(0, limit)
    .map((row) => String(row.id))
}

/**
 * The id of the record that survives a merge.
 *
 * HubSpot mints a NEW id for the merged contact and lists both old ones in
 * hs_merged_object_ids. A read by an old id redirects, but an association read
 * by an old id comes back empty (seen 15 Sep 2026: 0 calls by the old id, 2 by
 * the new one), so the survivor's id is the one to keep.
 */
export async function mergedObjectId(response: Response, fallback: string): Promise<string> {
  try {
    const data = (await response.json()) as { id?: string | number }
    const id = String(data.id ?? '').trim()
    return /^\d{1,20}$/.test(id) ? id : fallback
  } catch {
    return fallback
  }
}

/** The call engagements on a contact, by id. Empty on any failure. */
export async function callIdsOnContact(
  contactId: string,
  fetcher: HubSpotFetcher = hubspotFetch,
): Promise<string[]> {
  try {
    const response = await fetcher(
      `https://api.hubapi.com/crm/v4/objects/contacts/${contactId}/associations/calls?limit=100`,
    )
    if (!response.ok) return []
    const data = (await response.json()) as { results?: { toObjectId?: string | number }[] }
    return (data.results ?? []).map((row) => String(row.toObjectId ?? '')).filter((id) => /^\d+$/.test(id))
  } catch {
    return []
  }
}

export interface AssociationOutcome {
  company: string | null
  deals: string[]
}

type AssociationInput = { from: { id: string }; to: { id: string } }

/**
 * Put the contact's primary company and open deals on each of these calls.
 *
 * Two reads, then at most two writes through HubSpot's default-association
 * batch endpoint, which needs no association type ids. Deals come from the
 * search API filtered on the contact and on hs_is_closed, sorted newest first,
 * so the five HubSpot means are the five HubSpot returns.
 */
export async function associateLikeHubSpot(
  contactId: string,
  callIds: readonly string[],
  fetcher: HubSpotFetcher = hubspotFetch,
): Promise<AssociationOutcome> {
  const none: AssociationOutcome = { company: null, deals: [] }
  if (callIds.length === 0) return none
  try {
    const [companies, deals] = await Promise.all([
      fetcher(`https://api.hubapi.com/crm/v4/objects/contacts/${contactId}/associations/companies`),
      fetcher('https://api.hubapi.com/crm/v3/objects/deals/search', {
        method: 'POST',
        body: JSON.stringify({
          filterGroups: [
            {
              filters: [
                { propertyName: 'associations.contact', operator: 'EQ', value: contactId },
                { propertyName: 'hs_is_closed', operator: 'EQ', value: 'false' },
              ],
            },
          ],
          sorts: [{ propertyName: 'createdate', direction: 'DESCENDING' }],
          properties: ['createdate', 'hs_is_closed'],
          limit: OPEN_DEAL_LIMIT,
        }),
      }),
    ])
    const company = companies.ok
      ? primaryCompanyId(((await companies.json()) as { results?: AssociationRow[] }).results ?? [])
      : null
    const dealIds = deals.ok ? openDealIds(((await deals.json()) as { results?: DealRow[] }).results ?? []) : []

    const writes: Promise<void>[] = []
    if (company) {
      writes.push(
        associateDefault('companies', callIds.map((id) => ({ from: { id }, to: { id: company } })), fetcher),
      )
    }
    if (dealIds.length > 0) {
      writes.push(
        associateDefault(
          'deals',
          callIds.flatMap((id) => dealIds.map((deal) => ({ from: { id }, to: { id: deal } }))),
          fetcher,
        ),
      )
    }
    await Promise.all(writes)
    return { company, deals: dealIds }
  } catch (error) {
    console.error('calls: could not associate the call the way HubSpot would', {
      contactId,
      error: error instanceof Error ? error.message : error,
    })
    return none
  }
}

async function associateDefault(
  toObjectType: 'companies' | 'deals',
  inputs: AssociationInput[],
  fetcher: HubSpotFetcher,
): Promise<void> {
  const response = await fetcher(
    `https://api.hubapi.com/crm/v4/associations/calls/${toObjectType}/batch/associate/default`,
    { method: 'POST', body: JSON.stringify({ inputs }) },
  )
  if (!response.ok) {
    console.error('calls: HubSpot refused the association', {
      toObjectType,
      status: response.status,
      body: (await response.text()).slice(0, 300),
    })
  }
}
