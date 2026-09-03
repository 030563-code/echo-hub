import 'server-only'
import { hubspotFetch } from '@/lib/hubspot-client'
import {
  HUBSPOT_MAX_IN_VALUES,
  type DealFilters,
  type ResolvedAssociationIds,
} from '@/lib/deal-filters'

/**
 * Turn the company and contact text a rep typed into the HubSpot ids the deal
 * search filters on.
 *
 * HubSpot's Search API does not RETURN associations, which is why the deal list
 * cannot show an associated company. It does FILTER on them: the pseudo-
 * properties `associations.company` and `associations.contact` accept EQ and
 * IN, verified live on 2026-09-03. So the filter goes into the same search call
 * as every other filter, and there is no batch association read and no local
 * post-filtering, which is what would have made the filter lie for any deal
 * outside the fetched page.
 *
 * Resolution is deliberately NOT owner-scoped, unlike searchCompanies, which
 * fails closed for a non-super-admin because it picks the company a new deal
 * will be attached to. Here the scoping is already done: getDeals and
 * getDealsForBoard pin `hubspot_owner_id EQ` for any non-admin, so the deals
 * that come back are the rep's own whatever company ids go in. Scoping the
 * lookup as well would drop a rep's own deal whenever it hangs off a company
 * record another rep owns, which this portal's per-owner duplicates make
 * routine. If that owner pinning is ever loosened, this comment is the thing
 * that stops being true.
 */

/** Enough to fill an IN list, plus nothing: HubSpot reports the exact `total`
 *  separately, so overflow is detected without asking for more rows. */
const RESOLVE_LIMIT = HUBSPOT_MAX_IN_VALUES

export type AssociationResolution =
  | { ok: true; resolved: ResolvedAssociationIds }
  /** The text matched nothing. The caller returns an empty list saying so,
   *  rather than dropping the filter and showing every deal. */
  | { ok: false; kind: 'no_matches'; error: string }
  /** The text matched more records than one IN list holds. Truncating would
   *  return a plausible subset, which is worse than refusing: the rep would
   *  have no way to tell that deals were missing. */
  | { ok: false; kind: 'too_many'; error: string }
  | { ok: false; kind: 'failed'; error: string }

interface SearchGroup {
  filters: { propertyName: string; operator: string; value: string }[]
}

async function searchIds(
  objectType: 'companies' | 'contacts',
  filterGroups: SearchGroup[],
): Promise<{ ids: string[]; total: number } | null> {
  const response = await hubspotFetch(`https://api.hubapi.com/crm/v3/objects/${objectType}/search`, {
    method: 'POST',
    body: JSON.stringify({
      filterGroups,
      properties: ['hs_object_id'],
      limit: RESOLVE_LIMIT,
    }),
  })
  if (!response.ok) {
    console.error(`HubSpot ${objectType} resolution failed:`, await response.text())
    return null
  }
  const data = (await response.json()) as { total?: number; results?: { id: string }[] }
  return {
    ids: (data.results ?? []).map((r) => r.id),
    total: Number(data.total ?? 0),
  }
}

/** CONTAINS_TOKEN is token-based, so a bare "acme" does not match "Acme
 *  Corporation". The trailing wildcard is what makes it behave like the
 *  substring search a rep expects from a text box. */
function token(value: string): string {
  const trimmed = value.trim()
  return trimmed.endsWith('*') ? trimmed : `${trimmed}*`
}

/**
 * Resolve whichever of the two boxes the rep filled in.
 *
 * Returns { ok: true, resolved: {} } when both are blank, so the caller can
 * always call this and pass the result straight to buildDealFilterGroup.
 */
export async function resolveAssociationFilters(filters: DealFilters): Promise<AssociationResolution> {
  const company = filters.company.trim()
  const contact = filters.contact.trim()
  if (company === '' && contact === '') return { ok: true, resolved: {} }

  const resolved: ResolvedAssociationIds = {}

  if (company !== '') {
    // Name OR domain: filterGroups are OR'd, filters within one are AND'd.
    const found = await searchIds('companies', [
      { filters: [{ propertyName: 'name', operator: 'CONTAINS_TOKEN', value: token(company) }] },
      { filters: [{ propertyName: 'domain', operator: 'CONTAINS_TOKEN', value: token(company) }] },
    ])
    if (!found) {
      return { ok: false, kind: 'failed', error: 'Could not look up that company in HubSpot. Please try again.' }
    }
    if (found.total === 0) {
      return { ok: false, kind: 'no_matches', error: `No company matches “${company}”.` }
    }
    if (found.total > HUBSPOT_MAX_IN_VALUES) {
      return {
        ok: false,
        kind: 'too_many',
        error: `“${company}” matches ${found.total} companies, more than the ${HUBSPOT_MAX_IN_VALUES} this filter can hold. Type more of the name.`,
      }
    }
    resolved.companyIds = found.ids
  }

  if (contact !== '') {
    const found = await searchIds('contacts', [
      { filters: [{ propertyName: 'email', operator: 'CONTAINS_TOKEN', value: token(contact) }] },
      { filters: [{ propertyName: 'firstname', operator: 'CONTAINS_TOKEN', value: token(contact) }] },
      { filters: [{ propertyName: 'lastname', operator: 'CONTAINS_TOKEN', value: token(contact) }] },
    ])
    if (!found) {
      return { ok: false, kind: 'failed', error: 'Could not look up that contact in HubSpot. Please try again.' }
    }
    if (found.total === 0) {
      return { ok: false, kind: 'no_matches', error: `No contact matches “${contact}”.` }
    }
    if (found.total > HUBSPOT_MAX_IN_VALUES) {
      return {
        ok: false,
        kind: 'too_many',
        error: `“${contact}” matches ${found.total} contacts, more than the ${HUBSPOT_MAX_IN_VALUES} this filter can hold. Type more of the name or use the full email address.`,
      }
    }
    resolved.contactIds = found.ids
  }

  return { ok: true, resolved }
}
