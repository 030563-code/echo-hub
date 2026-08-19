'use server'

import { createServerClient } from '@/lib/supabase/server'
import { hasCapability } from '@/lib/authz'

interface CreateContactParams {
  firstname: string
  lastname: string
  email: string
  phone?: string
  companyId?: string
}

// Dedup guard: email is the reliable key for a contact. Search for an exact
// case-insensitive, trimmed match rather than trust the search API's own
// matching (same reasoning as createCompany.ts's name dedup).
async function findExistingContactByEmail(accessToken: string, email: string): Promise<string | null> {
  const target = email.trim().toLowerCase()
  if (!target) return null

  const response = await fetch('https://api.hubapi.com/crm/v3/objects/contacts/search', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      filterGroups: [
        {
          filters: [{ propertyName: 'email', operator: 'EQ', value: target }],
        },
      ],
      properties: ['email'],
      limit: 10,
    }),
    cache: 'no-store',
  })

  if (!response.ok) return null

  const data = await response.json()
  const results = (data.results ?? []) as Array<{ id: string; properties: { email?: string } }>
  const match = results.find((c) => (c.properties.email ?? '').trim().toLowerCase() === target)
  return match ? match.id : null
}

export async function createHubSpotContact(params: CreateContactParams): Promise<{ success: boolean; contactId?: string; error?: string }> {
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
    // Avoid minting a duplicate contact for an existing email — return the
    // existing record instead of creating a new one.
    const existingContactId = await findExistingContactByEmail(accessToken, params.email)
    if (existingContactId) {
      // The create path below would have associated a new contact with the
      // company — do the same for the reused record. Non-fatal on failure: the
      // deal itself still gets both associations at deal creation.
      if (params.companyId) {
        const assocResponse = await fetch(
          `https://api.hubapi.com/crm/v4/objects/contacts/${existingContactId}/associations/default/companies/${params.companyId}`,
          { method: 'PUT', headers: { Authorization: `Bearer ${accessToken}` } }
        )
        if (!assocResponse.ok) {
          console.error('Failed to associate existing contact with company:', assocResponse.status)
        }
      }
      return { success: true, contactId: existingContactId }
    }

    interface ContactAssociation {
      to: { id: string }
      types: { associationCategory: string; associationTypeId: number }[]
    }
    interface ContactRequestBody {
      properties: {
        firstname: string
        lastname: string
        email: string
        phone?: string
      }
      associations?: ContactAssociation[]
    }

    const body: ContactRequestBody = {
      properties: {
        firstname: params.firstname,
        lastname: params.lastname,
        email: params.email,
        phone: params.phone
      }
    }

    if (params.companyId) {
      body.associations = [
        {
          to: { id: params.companyId },
          types: [
            {
              associationCategory: "HUBSPOT_DEFINED",
              associationTypeId: 279 // Contact to Company
            }
          ]
        }
      ]
    }

    const response = await fetch('https://api.hubapi.com/crm/v3/objects/contacts', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      cache: 'no-store'
    })

    if (!response.ok) {
      const errorText = await response.text()
      console.error('HubSpot Create Contact Error:', errorText)
      return { success: false, error: 'Failed to create contact in HubSpot' }
    }

    const data = await response.json()
    return { success: true, contactId: data.id }

  } catch (error: unknown) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
}
