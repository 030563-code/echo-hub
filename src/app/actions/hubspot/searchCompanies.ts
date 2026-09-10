'use server'

import { createServerClient } from '@/lib/supabase/server'
import { getAuthorizedUser } from '@/lib/authz'
import { getOwnerIndex } from '@/app/actions/hubspot/getOwners'
import { ownerLabel } from '@/lib/hubspot-owners'
import { teamsForPipeline } from '@/lib/pipeline-config'

interface CompanySearchResult {
  id: string
  name: string
  domain?: string
  source: 'hubspot' | 'supabase'
  /** Who holds the record in HubSpot, so two colleagues' records stay tellable apart. */
  owner?: string
  xero_code_usa?: string
  xero_code_can?: string
}

export async function searchCompanies(query: string): Promise<{ success: boolean; data?: CompanySearchResult[]; error?: string }> {
  const supabase = await createServerClient()
  const auth = await getAuthorizedUser()
  if (!auth.ok) return { success: false, error: auth.error }
  // APP-3: CRM-proxy read requires quotes access (closes object-level confidentiality IDOR).
  //
  // pricing.manage counts too. The contractor editor on /pricing/contracts uses
  // this search to attach a contract price to a real HubSpot company, and it is
  // the only way to add a contractor at all, so a pure pricing admin was locked
  // out of their own page. Same read, same scoping below; only the list of
  // capabilities that reach it widens.
  if (
    !auth.capabilities.has('quotes.view') &&
    !auth.capabilities.has('quotes.create') &&
    !auth.capabilities.has('pricing.manage')
  ) {
    return { success: false, error: 'Forbidden: needs quotes or pricing access' }
  }

  const accessToken = process.env.HUBSPOT_ACCESS_TOKEN

  // SCOPED TO THE REP'S REGION, BY TEAM. Dean, 9 Sep 2026: "Jillian should only
  // see her USA sales team companies, those made under a person under her
  // pipeline."
  //
  // This used to pin `hubspot_owner_id` to the caller, which was far too tight:
  // measured against the live portal on 9 Sep 2026 that rep owned 426 of 57,400
  // companies, so Dimeo Construction was unfindable because a colleague who has
  // since left brought it in. Widening it to the whole portal was too loose the
  // other way, offering a US rep the five European HERMEQ records.
  //
  // The right dimension is the team. `hs_all_team_ids` is stamped on the COMPANY
  // and SURVIVES THE OWNER LEAVING, which is what makes it work here: Dimeo's
  // owner is archived and carries no teams at all, yet the company still reads
  // team 949190. Owner-based scoping cannot reach those records by any route;
  // this does. USA sales sees 27,994 companies, and none of the UK's 8,058,
  // Europe's 1,299 or Australia's 1,047.
  //
  // Known gap, Dean's call on 9 Sep 2026: 16,483 companies carry NO team stamp,
  // nearly all of them one departed rep's US accounts. They stay out of every
  // non-admin's search until someone stamps a team on them.
  //
  // The owner name still rides on each result: within one team several people
  // hold records, and a departed colleague's name explains a record nobody
  // recognises.
  let teamScope: string[] | null = null
  if (!auth.profile.is_super_admin) {
    teamScope = teamsForPipeline(auth.profile.pipeline_id)
    if (teamScope.length === 0) {
      // Fail closed. An unscoped search here would hand a rep with no region
      // set every company in the portal, which is the thing this exists to stop.
      return {
        success: false,
        error: 'Your sales region is not set, so company search cannot be scoped to your team. An administrator needs to set your region on your profile.',
      }
    }
  }

  try {
    // 1. Search Supabase (Account Registry) - Fuzzy Search. Admins only: the
    // registry carries Xero account codes against a HubSpot company id and has
    // no team column, so there is no way to scope it and a hit would leak a
    // company from another region.
    let supabaseCompanies: Record<string, string>[] | null = null
    if (!teamScope) {
      const { data, error: sbError } = await supabase
        .from('account_registry')
        .select('*')
        .ilike('hubspot_company_name', `%${query}%`)
        .limit(5)
      if (sbError) console.error('account_registry search failed:', sbError.message)
      supabaseCompanies = data
    }

    const sbResults: CompanySearchResult[] = (supabaseCompanies || []).map(c => ({
      id: c.hubspot_company_id.toString(),
      name: c.hubspot_company_name || 'Unknown',
      source: 'supabase',
      xero_code_usa: c.usa_xero_account_code,
      xero_code_can: c.canada_xero_account_code
    }))

    // 2. Search HubSpot (if token exists)
    let hsResults: CompanySearchResult[] = []
    if (accessToken) {
      // IN rather than EQ because one pipeline can draw on several teams: EURO
      // SALES is fed by Europe, France and Spain. Verified live on the portal,
      // `hs_all_team_ids` accepts both.
      const teamFilter = teamScope
        ? [{ propertyName: 'hs_all_team_ids', operator: 'IN', values: teamScope }]
        : []
      const response = await fetch('https://api.hubapi.com/crm/v3/objects/companies/search', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          // Groups are ORed, filters within a group are ANDed, so the team
          // filter has to be repeated in BOTH groups. Dropping it from either
          // one would leak another region's companies through that half of the
          // search, which is exactly what the fail-closed check above prevents.
          filterGroups: [
            {
              filters: [
                { propertyName: 'name', operator: 'CONTAINS_TOKEN', value: query },
                ...teamFilter,
              ]
            },
            {
              filters: [
                // The trailing wildcard is required. CONTAINS_TOKEN on `domain`
                // matches whole tokens, so a bare "sunbelt" hits sunbelt.com
                // alone; "sunbelt*" also finds sunbeltrentals.com and its
                // country variants. Measured against the live portal: 1 hit
                // versus 10.
                { propertyName: 'domain', operator: 'CONTAINS_TOKEN', value: `${query}*` },
                ...teamFilter,
              ]
            }
          ],
          properties: ['name', 'domain', 'hubspot_owner_id'],
          limit: 50,
        }),
        cache: 'no-store'
      })

      if (response.ok) {
        const data = await response.json()
        // Names for the owner ids. One indexed fetch, memoised for ten minutes
        // and shared with the deals board. An empty index degrades to a dash,
        // never to a throw.
        const owners = await getOwnerIndex()
        hsResults = (data.results as Array<{ id: string; properties: { name: string; domain?: string; hubspot_owner_id?: string } }>).map(c => ({
          id: c.id,
          name: c.properties.name,
          domain: c.properties.domain,
          source: 'hubspot',
          owner: ownerLabel(owners, c.properties.hubspot_owner_id)
        }))
      }
    }

    // 3. Merge Results (Deduplicate by ID)
    const allResults = [...sbResults, ...hsResults]
    const uniqueResults = Array.from(new Map(allResults.map(item => [item.id, item])).values())

    return { success: true, data: uniqueResults }

  } catch (error: unknown) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
}
