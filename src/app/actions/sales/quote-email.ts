'use server'

import { createAdminClient } from '@/lib/supabase/admin'
import { assertDealAccess } from '@/lib/authz'

/**
 * Records that a rep opened the Gmail window for a quote.
 *
 * Not proof the email was sent: nothing leaves the Hub, and the rep may still
 * close the tab. It answers the cheaper question of whether a published quote
 * was ever taken as far as composing, which is the gap worth spotting when a
 * deal goes quiet.
 */
export async function markQuoteEmailComposed(dealQuoteId: string): Promise<{ success: boolean }> {
  const admin = createAdminClient()
  const { data: row } = await admin
    .from('deal_quotes')
    .select('hubspot_deal_id')
    .eq('id', dealQuoteId)
    .maybeSingle()
  if (!row) return { success: false }

  // The row is keyed by a quote id the caller could guess, so the deal it
  // belongs to still has to be one they may touch.
  const access = await assertDealAccess((row as { hubspot_deal_id: string }).hubspot_deal_id, 'quotes.create')
  if (!access.ok) return { success: false }

  await admin
    .from('deal_quotes')
    .update({ email_composed_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq('id', dealQuoteId)
  return { success: true }
}
