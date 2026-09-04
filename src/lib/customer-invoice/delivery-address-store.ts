import 'server-only'

import { createAdminClient } from '@/lib/supabase/admin'
import type { SavedDeliveryAddress } from '@/lib/customer-invoice/delivery-address-book'

/**
 * Reading a customer's remembered ship-to addresses.
 *
 * `server-only`, NOT `'use server'`, and the distinction is the whole point.
 * Every export of a `'use server'` module becomes a remotely callable server
 * action. This function takes a contact key and returns that customer's saved
 * addresses through the admin client, which bypasses RLS by design. Exported
 * from an action module it would have been an unauthenticated endpoint for
 * reading any customer's delivery history by guessing 'xero:<code>'.
 *
 * Here it can only be called by code that already runs on the server: the
 * invoice page, which has passed its invoicing.view gate, and saveDeliveryAddress,
 * which has passed requireInvoicingManage and loaded the invoice.
 */
export async function listDeliveryAddresses(
  contactKey: string | null,
): Promise<SavedDeliveryAddress[]> {
  if (!contactKey) return []

  const { data, error } = await createAdminClient()
    .from('customer_delivery_addresses')
    .select('id, street, city, state, zip, country, location, requested_by, last_used_at')
    .eq('contact_key', contactKey)
    .order('last_used_at', { ascending: false })
    .limit(50)

  if (error) {
    // A book that cannot be read is a missing convenience, never a reason to
    // stop someone invoicing. The editor falls back to plain manual entry.
    console.error('listDeliveryAddresses failed', error.message)
    return []
  }

  return (data ?? []).map((row) => ({
    id: String(row.id),
    street: (row.street as string) ?? '',
    city: (row.city as string) ?? '',
    state: (row.state as string) ?? '',
    zip: (row.zip as string) ?? '',
    country: (row.country as string) ?? 'US',
    location: (row.location as string) ?? null,
    requestedBy: (row.requested_by as string) ?? null,
    lastUsedAt: (row.last_used_at as string) ?? null,
  }))
}
