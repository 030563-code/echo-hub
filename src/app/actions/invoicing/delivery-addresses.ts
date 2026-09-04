'use server'

import { z } from 'zod'
import { revalidatePath } from 'next/cache'
import { createAdminClient } from '@/lib/supabase/admin'
import {
  deliveryAddressFingerprint,
  deliveryContactKey,
  isSaveableDeliveryAddress,
  type SavedDeliveryAddress,
} from '@/lib/customer-invoice/delivery-address-book'
import { US_STATE_CODES } from '@/lib/us-address'
import { loadInvoiceWithLines, requireInvoicingManage } from './shared'

/**
 * The saved ship-to addresses a rep can pick from, per customer.
 *
 * A rental firm has one Xero contact and a dozen yards, and today a rep retypes
 * one of them on every invoice. The book turns that into a dropdown.
 *
 * customer_delivery_addresses is service-role only, with no grant and no policy,
 * the same doctrine customer_invoices and invoice_attachments follow. Both
 * actions here start from requireInvoicingManage and load the invoice, so the
 * caller has proved they may work on THIS invoice before its customer's address
 * history is read or added to.
 *
 * Reads happen server-side on the page, not through an action, so the dropdown
 * is populated on first paint. This file holds the write and the one read a
 * client genuinely needs after saving.
 */

const addressSchema = z.object({
  invoiceId: z.string().uuid(),
  street: z.string().trim().min(1).max(255),
  city: z.string().trim().min(1).max(100),
  state: z.enum(US_STATE_CODES),
  zip: z.string().trim().regex(/^\d{5}(-\d{4})?$/, 'Zip must be 5 digits or ZIP+4.'),
  country: z.string().trim().max(2).default('US'),
  // Both optional and both free text: a depot label is whatever the customer
  // calls it, and a requester is a person's name.
  location: z.string().trim().max(120).nullable().default(null),
  requestedBy: z.string().trim().max(120).nullable().default(null),
})

export interface DeliveryAddressResult {
  success: boolean
  error?: string
  addresses?: SavedDeliveryAddress[]
}

/** Map a database row to the shape the editor renders. */
function toSaved(row: Record<string, unknown>): SavedDeliveryAddress {
  return {
    id: String(row.id),
    street: (row.street as string) ?? '',
    city: (row.city as string) ?? '',
    state: (row.state as string) ?? '',
    zip: (row.zip as string) ?? '',
    country: (row.country as string) ?? 'US',
    location: (row.location as string) ?? null,
    requestedBy: (row.requested_by as string) ?? null,
    lastUsedAt: (row.last_used_at as string) ?? null,
  }
}

/**
 * The addresses already known for an invoice's customer, most recently used
 * first. Exported for the page as well as for the editor's refresh after a save.
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
  return (data ?? []).map(toSaved)
}

/**
 * Remember the address currently on an invoice, so it is offered next time.
 *
 * Upsert on (contact_key, fingerprint), which is what stops the same yard being
 * added a second time with different spacing. Saving one that is already there
 * bumps last_used_at instead, so the dropdown sorts by what the customer
 * actually uses.
 */
export async function saveDeliveryAddress(input: unknown): Promise<DeliveryAddressResult> {
  const gate = await requireInvoicingManage()
  if (!gate.ok) return { success: false, error: gate.error }

  const parsed = addressSchema.safeParse(input)
  if (!parsed.success) {
    return { success: false, error: parsed.error.issues[0]?.message ?? 'That address cannot be saved.' }
  }
  const value = parsed.data

  const loaded = await loadInvoiceWithLines(value.invoiceId)
  if (!loaded.ok) return { success: false, error: loaded.error }
  const invoice = loaded.invoice

  const contactKey = deliveryContactKey(
    invoice.taxjar_customer_id as string | null,
    (invoice as { hubspot_company_id?: string | null }).hubspot_company_id ?? null,
  )
  if (!contactKey) {
    return {
      success: false,
      error: 'This invoice has no Xero account code and no HubSpot company, so there is nothing to file the address under.',
    }
  }

  const address = {
    street: value.street,
    city: value.city,
    state: value.state,
    zip: value.zip,
    country: value.country || 'US',
    location: value.location,
    requestedBy: value.requestedBy,
  }
  if (!isSaveableDeliveryAddress(address)) {
    return { success: false, error: 'Fill in the street, city, state and zip before saving the address.' }
  }

  const { error } = await createAdminClient()
    .from('customer_delivery_addresses')
    .upsert(
      {
        contact_key: contactKey,
        fingerprint: deliveryAddressFingerprint(address),
        xero_account_code: (invoice.taxjar_customer_id as string | null) ?? null,
        hubspot_company_id: (invoice as { hubspot_company_id?: string | null }).hubspot_company_id ?? null,
        company_name: (invoice as { company_name?: string | null }).company_name ?? null,
        street: address.street,
        city: address.city,
        state: address.state,
        zip: address.zip,
        country: address.country,
        location: address.location,
        requested_by: address.requestedBy,
        created_by_uid: gate.auth.user.id,
        created_by_label: gate.auth.user.email ?? null,
        last_used_at: new Date().toISOString(),
      },
      { onConflict: 'contact_key,fingerprint' },
    )

  if (error) {
    console.error('saveDeliveryAddress failed', error.message)
    return { success: false, error: 'The address could not be saved. Try again.' }
  }

  revalidatePath(`/invoicing/${invoice.hubspot_deal_id}`)
  return { success: true, addresses: await listDeliveryAddresses(contactKey) }
}
