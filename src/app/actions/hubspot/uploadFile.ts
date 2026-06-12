'use server'

import { getAuthorizedUser, assertDealAccess } from '@/lib/authz'

export async function uploadFileToHubSpot(formData: FormData): Promise<{ success: boolean; fileId?: string; error?: string }> {
  const auth = await getAuthorizedUser()
  if (!auth.ok) return { success: false, error: auth.error }

  const accessToken = process.env.HUBSPOT_ACCESS_TOKEN
  if (!accessToken) return { success: false, error: 'Token Missing' }

  const file = formData.get('file') as File
  if (!file) return { success: false, error: 'No file provided' }

  const ALLOWED_TYPES = ['application/pdf']
  const MAX_SIZE_BYTES = 10 * 1024 * 1024 // 10 MB

  if (!ALLOWED_TYPES.includes(file.type)) {
    return { success: false, error: 'Only PDF files are allowed' }
  }
  if (file.size > MAX_SIZE_BYTES) {
    return { success: false, error: 'File must be under 10 MB' }
  }

  try {
    // HubSpot Files API requires 'folderPath' or 'folderId'. We'll use root '/' if not specified.
    // options: JSON string
    const fileOptions = {
      access: 'PRIVATE', // or PUBLIC_INDEXABLE
      overwrite: false,
      duplicateValidationStrategy: 'NONE',
      duplicateValidationScope: 'ENTIRE_PORTAL'
    }

    const hubspotFormData = new FormData()
    hubspotFormData.append('file', file)
    hubspotFormData.append('options', JSON.stringify(fileOptions))
    hubspotFormData.append('folderPath', '/quotes') // Store in a quotes folder

    const response = await fetch('https://api.hubapi.com/files/v3/files', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
      body: hubspotFormData,
      cache: 'no-store'
    })

    if (!response.ok) {
      const errorText = await response.text()
      console.error('HubSpot upload file error:', errorText)
      return { success: false, error: 'Failed to upload file. Please try again.' }
    }

    const data = await response.json() as { id?: string }
    return { success: true, fileId: data.id }

  } catch (error: unknown) {
    console.error('uploadFileToHubSpot Exception:', error)
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export async function createNoteWithAttachment(dealId: string, fileId: string) {
  // IDOR guard (finding #5): these actions previously had NO auth check at all.
  const access = await assertDealAccess(dealId)
  if (!access.ok) return { success: false, error: access.error }

  const accessToken = process.env.HUBSPOT_ACCESS_TOKEN
  if (!accessToken) return { success: false, error: 'Token Missing' }

  try {
    const payload = {
      properties: {
        hs_note_body: "Quote Generated via Sales Tool",
        hs_timestamp: new Date().toISOString(),
        hs_attachment_ids: String(fileId) // Ensure string
      },
      associations: [
        {
          to: { id: dealId },
          types: [
            {
              associationCategory: "HUBSPOT_DEFINED",
              associationTypeId: 214 // Deal to Note
            }
          ]
        }
      ]
    }

    const response = await fetch('https://api.hubapi.com/crm/v3/objects/notes', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      cache: 'no-store'
    })

    if (!response.ok) {
      const errorText = await response.text()
      console.error('HubSpot Create Note Error:', errorText)
      return { success: false, error: 'Failed to create note in HubSpot: ' + errorText }
    }

    await response.json()
    return { success: true }

  } catch (error: unknown) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export async function createEmailDraftWithAttachment(dealId: string, fileId: string) {
  // IDOR guard (finding #5): these actions previously had NO auth check at all.
  const access = await assertDealAccess(dealId)
  if (!access.ok) return { success: false, error: access.error }

  const accessToken = process.env.HUBSPOT_ACCESS_TOKEN
  if (!accessToken) return { success: false, error: 'Token Missing' }

  try {
    // Create Email Engagement
    // Note: 'hs_email_status': 'SENT' logs it as sent. 'DRAFT' might not be supported for engagements in the way user expects (opening in UI).
    // However, user requested this specific payload structure.
    const response = await fetch('https://api.hubapi.com/crm/v3/objects/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        properties: {
          hs_timestamp: new Date().toISOString(),
          hs_email_direction: "EMAIL",
          hs_email_status: "SENT", // User requested SENT, though they said "draft email". Engagements are usually history.
          hs_email_subject: "Quote Attached",
          hs_email_text: "Please find the quote attached.",
          hs_attachment_ids: fileId
        },
        associations: [
          {
            to: { id: dealId },
            types: [
              {
                associationCategory: "HUBSPOT_DEFINED",
                associationTypeId: 210 // Deal to Email
              }
            ]
          }
        ]
      }),
      cache: 'no-store'
    })

    if (!response.ok) {
      const errorText = await response.text()
      console.error('HubSpot Create Email Error:', errorText)
      return { success: false, error: 'Failed to create email engagement' }
    }

    return { success: true }

  } catch (error: unknown) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
}
