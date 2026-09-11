'use server'

import { getAuthorizedUser, hasCapability } from '@/lib/authz'
import { resolveHubSpotOwnerId } from '@/lib/hubspot-owner'
import { teamsForPipeline } from '@/lib/pipeline-config'
import { externalCallsDisabled, STAGING_SKIP_NOTE } from '@/lib/env'

interface CreateCompanyParams {
  name: string
  domain: string
}

// Dedup guard: search for a company whose name matches exactly once trimmed
// and lower-cased. HubSpot's search API doesn't offer a case-insensitive EQ,
// so we fetch candidates (CONTAINS_TOKEN, same pattern as searchCompanies.ts)
// and compare exactly in code rather than trust the API's own matching.
// A candidate with a conflicting domain is treated as a different business.
//
// Scoped to the caller's TEAM, matching searchCompanies. It used to match only
// the caller's OWN records, which paired badly with a search scoped the same
// way: a rep who could not SEE a colleague's existing company could not dedup
// against it either, so the guard against a second record for one business
// never fired. Team scope fixes that while keeping the deliberate per-region
// duplicates apart: a US rep deduping against the UK's record of the same
// business would attach their pipeline to the wrong region's account.
async function findExistingCompanyByName(
  accessToken: string,
  name: string,
  domain: string,
  teamScope: string[] | null
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
          filters: [
            { propertyName: 'name', operator: 'CONTAINS_TOKEN', value: name.trim() },
            ...(teamScope
              ? [{ propertyName: 'hs_all_team_ids', operator: 'IN', values: teamScope }]
              : []),
          ],
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
  const auth = await getAuthorizedUser()
  if (!auth.ok) return { success: false, error: auth.error }
  // APP-2: minting CRM objects in the shared portal requires quotes.create.
  if (!(await hasCapability('quotes.create'))) {
    return { success: false, error: 'Forbidden: missing quotes.create capability' }
  }

  if (externalCallsDisabled()) return { success: false, error: STAGING_SKIP_NOTE }

  const accessToken = process.env.HUBSPOT_ACCESS_TOKEN
  if (!accessToken) return { success: false, error: 'Token Missing' }

  // A new company MUST be owned by its creator, because HubSpot derives the
  // company's team stamp from the owner and the search is team-scoped: an
  // unowned company would carry no team and be invisible to everyone, its
  // creator included. So this still fails closed when the owner cannot be
  // resolved. Admins may create unowned records (they see everything).
  const ownerScope = auth.profile.is_super_admin
    ? null
    : await resolveHubSpotOwnerId(auth.user.email ?? '', accessToken)
  if (!auth.profile.is_super_admin && !ownerScope) {
    return { success: false, error: 'Could not link your HubSpot user, so the company would not appear in your searches. Please try again or contact an administrator.' }
  }

  const teamScope = auth.profile.is_super_admin ? null : teamsForPipeline(auth.profile.pipeline_id)
  if (teamScope && teamScope.length === 0) {
    return { success: false, error: 'Your sales region is not set, so a new company could not be filed against your team. An administrator needs to set your region on your profile.' }
  }

  try {
    // Avoid minting a duplicate company for an existing name — return the
    // existing record instead of creating a new one.
    const existing = await findExistingCompanyByName(accessToken, params.name, params.domain, teamScope)
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
          domain: params.domain,
          ...(ownerScope ? { hubspot_owner_id: ownerScope } : {})
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
