'use server'

import { createServerClient } from '@/lib/supabase/server'
import { hasAnyCapability } from '@/lib/authz'

interface ContactSearchResult {
  id: string
  properties: {
    firstname: string
    lastname: string
    email: string
    phone?: string
  }
  associations?: {
    companies?: {
      results: { id: string }[]
    }
  }
}

export async function searchHubSpotContact(query: string, domain?: string): Promise<{ success: boolean; data?: ContactSearchResult[]; error?: string }> {
  const supabase = await createServerClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) return { success: false, error: 'Unauthorized' }
  // APP-3: CRM-proxy read requires quotes access.
  if (!(await hasAnyCapability(['quotes.view', 'quotes.create']))) {
    return { success: false, error: 'Forbidden: missing quotes capability' }
  }

  const accessToken = process.env.HUBSPOT_ACCESS_TOKEN
  if (!accessToken) return { success: false, error: 'HubSpot Token Missing' }

  try {
    const filters = [
      { propertyName: 'email', operator: 'CONTAINS_TOKEN', value: query },
      { propertyName: 'firstname', operator: 'CONTAINS_TOKEN', value: query },
      { propertyName: 'lastname', operator: 'CONTAINS_TOKEN', value: query }
    ]

    // If domain is provided, add it as a required filter (AND logic)
    // However, HubSpot Search API 'filterGroups' are OR'd together, and filters inside are AND'd.
    // So we need to add the domain filter to EACH filter group if we want to restrict all searches to that domain.
    
    let filterGroups = []

    if (domain) {
      // Create a filter group for each search criteria + domain
      filterGroups = filters.map(f => ({
        filters: [
          f,
          { propertyName: 'email', operator: 'CONTAINS_TOKEN', value: domain } // Filter by email domain
        ]
      }))
    } else {
      // Original logic: OR between name/email
      filterGroups = filters.map(f => ({ filters: [f] }))
    }

    const response = await fetch('https://api.hubapi.com/crm/v3/objects/contacts/search', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        filterGroups,
        properties: ['firstname', 'lastname', 'email', 'phone'],
        limit: 50,
        sorts: ['firstname'],
      }),
      cache: 'no-store'
    })

    if (!response.ok) {
      return { success: false, error: 'Failed to search contacts' }
    }

    const data = await response.json()
    
    // For each contact, we might want to fetch associations if not returned by search (Search API doesn't always return associations directly in the same way as detail API, but let's try requesting it or doing a secondary fetch if needed. Actually, Search API does NOT return associations. We need to fetch them separately or rely on the user selecting a contact and then fetching details.)
    // Correction: Search API does not support `associations` in the response body directly. We have to fetch details for the selected contact.
    // Strategy: Return the contacts. When user selects one, we fetch the company link.
    
    return { success: true, data: data.results }

  } catch (error: unknown) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export async function getContactAssociations(contactId: string) {
  const supabase = await createServerClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { success: false, error: 'Unauthorized' }

  const accessToken = process.env.HUBSPOT_ACCESS_TOKEN
  try {
    const response = await fetch(
      `https://api.hubapi.com/crm/v3/objects/contacts/${contactId}?associations=companies`,
      {
        headers: { Authorization: `Bearer ${accessToken}` },
        cache: 'no-store'
      }
    )
    const data = await response.json()
    return { success: true, data }
  } catch (error: unknown) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
}
