'use server'

import { createServerClient } from '@/lib/supabase/server'
import { getAuthorizedUser } from '@/lib/authz'
import { getOwnerIndex } from '@/app/actions/hubspot/getOwners'
import { ownerLabel } from '@/lib/hubspot-owners'

interface CompanySearchResult {
  id: string
  name: string
  domain?: string
  source: 'hubspot' | 'supabase'
  /** Who holds the record in HubSpot, so same-named duplicates stay tellable apart. */
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

  // THE SEARCH IS PORTAL-WIDE. Dean, 9 Sep 2026: "is it possible for Jillian to
  // be able to select and see all the companies not just the companies under her
  // name ... she is trying to find Dimeo Construction but it is under a nancy
  // name", and "she can apparently see them in hubspot though".
  //
  // This used to pin `hubspot_owner_id` to the caller for anyone who is not a
  // super admin, on the reasoning that this portal duplicates a company per
  // owner (one HERMEQ record per region) and offering someone another rep's
  // same-named record invites attaching a deal to the wrong region's account.
  // The cure was worse than the disease. Measured against the live portal on
  // 9 Sep 2026: 9,500 companies, of which that rep owned 5. The filter hid
  // 99.9% of the CRM, and 5,796 of those companies belong to owners whose seat
  // is now archived (two departed reps hold 3,790 and 2,006), so those records
  // were unreachable for EVERY non-admin, permanently. HubSpot's own
  // permissions already let her see all of it, so the Hub was the only thing
  // standing in the way, and it was refusing to show her records she can open
  // in the CRM in the next tab.
  //
  // The duplicate risk is answered by naming the owner on every result instead
  // of hiding the record: the rep picks between two HERMEQs by reading who
  // holds each one. Deal visibility is untouched and still owner-pinned in
  // getDeals and getDealsForBoard; this is only about which company a new deal
  // can be attached to.

  try {
    // 1. Search Supabase (Account Registry) - Fuzzy Search. Now runs for every
    // caller: it was admin-only purely because the registry has no owner column
    // and so could not be owner-scoped, and there is no scope left to honour.
    const { data: supabaseCompanies, error: sbError } = await supabase
      .from('account_registry')
      .select('*')
      .ilike('hubspot_company_name', `%${query}%`)
      .limit(5)
    if (sbError) console.error('account_registry search failed:', sbError.message)

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
          // Groups are ORed, filters within a group are ANDed.
          filterGroups: [
            {
              filters: [
                { propertyName: 'name', operator: 'CONTAINS_TOKEN', value: query },
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
        // Names for the owner ids, so two same-named companies can be told
        // apart. One indexed fetch, memoised for ten minutes and shared with
        // the deals board. An empty index degrades to a dash, never to a throw.
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
