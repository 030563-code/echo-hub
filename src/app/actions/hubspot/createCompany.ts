'use server'

import { createServerClient } from '@/lib/supabase/server'
import { hasCapability } from '@/lib/authz'

interface CreateCompanyParams {
  name: string
  domain: string
}

// Dedup guard: search for a company whose name matches exactly once trimmed
// and lower-cased. HubSpot's search API doesn't offer a case-insensitive EQ,
// so we fetch candidates (CONTAINS_TOKEN, same pattern as searchCompanies.ts)
// and compare exactly in code rather than trust the API's own matching.
// A candidate with a conflicting domain is treated as a different business.
async function findExistingCompanyByName(
  accessToken: string,
  name: string,
  domain: string
): Promise<{ id: string; name: string; domain: string } | null> {
  const target = name.trim().toLowerCase()
  if (!target) return null

  const response = await fetch('https://api.hubapi.com/crm/v3/objects/companies/search', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      filterGroups: [
        {
          filters: [{ propertyName: 'name', operator: 'CONTAINS_TOKEN', value: name.trim() }],
        },
      ],
      properties: ['name', 'domain'],
      limit: 25,
    }),
    cache: 'no-store',
  })

  if (!response.ok) return null

  const data = await response.json()
  const results = (data.results ?? []) as Array<{ id: string; properties: { name?: string; domain?: string } }>
  const suppliedDomain = domain.trim().toLowerCase()
  const match = results.find((c) => {
    if ((c.properties.name ?? '').trim().toLowerCase() !== target) return false
    const existingDomain = (c.properties.domain ?? '').trim().toLowerCase()
    return !(existingDomain && suppliedDomain && existingDomain !== suppliedDomain)
  })
  if (!match) return null
  return {
    id: match.id,
    name: (match.properties.name ?? '').trim() || name.trim(),
    domain: (match.properties.domain ?? '').trim(),
  }
}

export async function createHubSpotCompany(params: CreateCompanyParams): Promise<{
  success: boolean
  companyId?: string
  error?: string
  /** True when an existing company was reused rather than created. */
  matchedExisting?: boolean
  /** The record's ACTUAL stored details (see createHubSpotContact). */
  company?: { name: string; domain: string }
}> {
  const supabase = await createServerClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) return { success: false, error: 'Unauthorized' }
  // APP-2: minting CRM objects in the shared portal requires quotes.create.
  if (!(await hasCapability('quotes.create'))) {
    return { success: false, error: 'Forbidden: missing quotes.create capability' }
  }

  const accessToken = process.env.HUBSPOT_ACCESS_TOKEN
  if (!accessToken) return { success: false, error: 'Token Missing' }

  try {
    // Avoid minting a duplicate company for an existing name — return the
    // existing record instead of creating a new one.
    const existing = await findExistingCompanyByName(accessToken, params.name, params.domain)
    if (existing) {
      return {
        success: true,
        companyId: existing.id,
        matchedExisting: true,
        company: { name: existing.name, domain: existing.domain },
      }
    }

    const response = await fetch('https://api.hubapi.com/crm/v3/objects/companies', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        properties: {
          name: params.name,
          domain: params.domain
        }
      }),
      cache: 'no-store'
    })

    if (!response.ok) {
      const errorText = await response.text()
      console.error('HubSpot Create Company Error:', errorText)
      return { success: false, error: 'Failed to create company in HubSpot' }
    }

    const data = await response.json()
    return {
      success: true,
      companyId: data.id,
      matchedExisting: false,
      company: { name: params.name.trim(), domain: params.domain.trim() },
    }

  } catch (error: unknown) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
}
