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
