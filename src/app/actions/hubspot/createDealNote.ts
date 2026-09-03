'use server'

import { assertDealAccess } from '@/lib/authz'
import { hubspotFetch } from '@/lib/hubspot-client'
import { commentsToHtml } from '@/lib/hubspot-quote'

/**
 * A note on a deal's HubSpot timeline.
 *
 * Lifted out of the quote-upload helper before that file was deleted with the
 * jsPDF document. The association type id, 214 for deal to note, is the one
 * thing here worth keeping: it was already proven against the live portal.
 *
 * hs_note_body renders as HTML, so the text is escaped and split into
 * paragraphs the same way a quote's comments are.
 */
export async function createDealNote(
  dealId: string,
  body: string,
): Promise<{ success: boolean; noteId?: string; error?: string }> {
  const access = await assertDealAccess(dealId, 'quotes.create')
  if (!access.ok) return { success: false, error: access.error }

  const html = commentsToHtml(body)
  if (!html) return { success: false, error: 'A note needs some text.' }

  const response = await hubspotFetch('https://api.hubapi.com/crm/v3/objects/notes', {
    method: 'POST',
    body: JSON.stringify({
      properties: {
        hs_timestamp: new Date().toISOString(),
        hs_note_body: html,
      },
      associations: [
        {
          to: { id: dealId },
          types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 214 }],
        },
      ],
    }),
  })

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    console.error('createDealNote failed', response.status, text)
    return { success: false, error: 'Could not write the note to HubSpot.' }
  }

  const created = (await response.json()) as { id: string }
  return { success: true, noteId: created.id }
}
