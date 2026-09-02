'use server'

import { createServerClient } from '@/lib/supabase/server'
import { getAuthorizedUser } from '@/lib/authz'
import { resolveHubSpotOwnerId } from '@/lib/hubspot-owner'

interface CompanySearchResult {
  id: string
  name: string
  domain?: string
  source: 'hubspot' | 'supabase'
  xero_code_usa?: string
  xero_code_can?: string
}

export async function searchCompanies(query: string): Promise<{ success: boolean; data?: CompanySearchResult[]; error?: string }> {
  const supabase = await createServerClient()
  const auth = await getAuthorizedUser()
  if (!auth.ok) return { success: false, error: auth.error }
  // APP-3: CRM-proxy read requires quotes access (closes object-level confidentiality IDOR).
  if (!auth.capabilities.has('quotes.view') && !auth.capabilities.has('quotes.create')) {
    return { success: false, error: 'Forbidden: missing quotes capability' }
  }

  const accessToken = process.env.HUBSPOT_ACCESS_TOKEN

  // Companies in this portal are deliberately duplicated per owner (e.g. one
  // HERMEQ record per region/rep), so a rep must only be offered THEIR OWN
  // records — surfacing another owner's same-named company invites attaching a
  // deal to the wrong region's account. Super admins see everything.
  let ownerScope: string | null = null
  if (!auth.profile.is_super_admin) {
    if (!accessToken) return { success: false, error: 'HubSpot Access Token not configured' }
    ownerScope = await resolveHubSpotOwnerId(auth.user.email ?? '', accessToken)
    if (!ownerScope) {
      // Fail closed: without a resolved owner the scope filter can't be built,
      // and returning unscoped results would leak every owner's companies.
      return { success: false, error: 'Could not link your HubSpot user for company search. Please try again or contact an administrator.' }
    }
  }

  try {
    // 1. Search Supabase (Account Registry) - Fuzzy Search. The registry has
    // no owner column, so it cannot be owner-scoped — admins only.
    let supabaseCompanies: Record<string, string>[] | null = null
    if (!ownerScope) {
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
      const response = await fetch('https://api.hubapi.com/crm/v3/objects/companies/search', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          // Groups are ORed, filters within a group are ANDed, so the owner
          // filter has to be repeated in BOTH groups. Dropping it from either
          // one would leak other reps' companies, which is exactly what the
          // fail-closed owner resolution above exists to prevent.
          filterGroups: [
            {
              filters: [
                { propertyName: 'name', operator: 'CONTAINS_TOKEN', value: query },
                ...(ownerScope
                  ? [{ propertyName: 'hubspot_owner_id', operator: 'EQ', value: ownerScope }]
                  : []),
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
                ...(ownerScope
                  ? [{ propertyName: 'hubspot_owner_id', operator: 'EQ', value: ownerScope }]
                  : []),
              ]
            }
          ],
          properties: ['name', 'domain'],
          limit: 50,
        }),
        cache: 'no-store'
      })

      if (response.ok) {
        const data = await response.json()
        hsResults = (data.results as Array<{ id: string; properties: { name: string; domain?: string } }>).map(c => ({
          id: c.id,
          name: c.properties.name,
          domain: c.properties.domain,
          source: 'hubspot'
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
