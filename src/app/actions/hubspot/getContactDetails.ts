'use server'

import { createServerClient } from '@/lib/supabase/server'
import { hasAnyCapability } from '@/lib/authz'

interface HubSpotContact {
  id: string
  properties: {
    firstname: string
    lastname: string
    email: string
    phone?: string
    jobtitle?: string
  }
}

interface GetContactDetailsResult {
  success: boolean
  data?: HubSpotContact
  error?: string
}

export async function getContactDetails(contactId: string): Promise<GetContactDetailsResult> {
  const supabase = await createServerClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    return { success: false, error: 'User not authenticated' }
  }

  // Module capability gate — object-level reads require quotes access (closes the
  // residual object-level IDOR: any authenticated user reading any contact by id).
  if (!(await hasAnyCapability(['quotes.view', 'quotes.create']))) {
    return { success: false, error: 'Forbidden: missing quotes capability' }
  }

  const accessToken = process.env.HUBSPOT_ACCESS_TOKEN
  if (!accessToken) {
    return { success: false, error: 'HubSpot Access Token not configured' }
  }

  try {
    const response = await fetch(
      `https://api.hubapi.com/crm/v3/objects/contacts/${contactId}?properties=firstname,lastname,email,phone,jobtitle`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        cache: 'no-store',
      }
    )

    if (!response.ok) {
      if (response.status === 404) {
        return { success: false, error: 'Contact not found' }
      }
      const errorText = await response.text()
      console.error('HubSpot Get Contact API Error:', errorText)
      return { success: false, error: 'Failed to fetch contact details' }
    }

    const data = await response.json()
    return { success: true, data }

  } catch (error: unknown) {
    console.error('getContactDetails Exception:', error)
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
}
