'use server'

import { createServerClient } from '@/lib/supabase/server'
import { hasAnyCapability } from '@/lib/authz'

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
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) return { success: false, error: 'Unauthorized' }
  // APP-3: CRM-proxy read requires quotes access (closes object-level confidentiality IDOR).
  if (!(await hasAnyCapability(['quotes.view', 'quotes.create']))) {
    return { success: false, error: 'Forbidden: missing quotes capability' }
  }

  const accessToken = process.env.HUBSPOT_ACCESS_TOKEN

  try {
    // 1. Search Supabase (Account Registry) - Fuzzy Search
    // Using ilike for simple fuzzy matching. For advanced fuzzy, we'd need pg_trgm extension.
    const { data: supabaseCompanies, error: sbError } = await supabase
      .from('account_registry')
      .select('*')
      .ilike('hubspot_company_name', `%${query}%`)
      .limit(5)

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
          filterGroups: [
            {
              filters: [
                { propertyName: 'name', operator: 'CONTAINS_TOKEN', value: query }
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
