import 'server-only'
import { hubspotFetch } from '@/lib/hubspot-client'
import type { ContactSnapshot } from './link-state'

/**
 * Read one HubSpot contact, for the snapshot a call carries.
 *
 * Server-only rather than a 'use server' action, for the reason written at the
 * top of src/lib/quote-publish-tail.ts: every export of a 'use server' file is
 * a callable endpoint, and this one takes a contact id from its caller.
 *
 * The fetcher is injectable so the reconcile rules can be tested without a
 * network, the shape src/lib/mrp/engine-data.ts already uses.
 */
export type HubSpotFetcher = typeof hubspotFetch

const CONTACT_PROPERTIES = 'firstname,lastname,email,phone,mobilephone'

export interface ContactRead {
  ok: boolean
  /** True when HubSpot said the contact is not there, as opposed to a failure. */
  notFound?: boolean
  contact?: ContactSnapshot & { id: string }
  error?: string
}

export async function readContact(
  contactId: string,
  fetcher: HubSpotFetcher = hubspotFetch,
): Promise<ContactRead> {
  if (!/^\d{1,20}$/.test(contactId)) return { ok: false, error: 'Not a contact id' }

  try {
    const response = await fetcher(
      `https://api.hubapi.com/crm/v3/objects/contacts/${contactId}?properties=${CONTACT_PROPERTIES}`,
    )
    if (response.status === 404) return { ok: false, notFound: true, error: 'Contact not found' }
    if (!response.ok) {
      const body = await response.text()
      console.error('readContact failed', { contactId, status: response.status, body: body.slice(0, 300) })
      return { ok: false, error: `HubSpot answered ${response.status}` }
    }
    const data = (await response.json()) as { id: string; properties?: Record<string, string | null> }
    const p = data.properties ?? {}
    return {
      ok: true,
      contact: {
        id: data.id,
        firstname: p.firstname ?? null,
        lastname: p.lastname ?? null,
        email: p.email ?? null,
        // The placeholder the phone system creates carries `phone`; a real
        // contact may carry only `mobilephone`, and for our purposes (does this
        // person have a number at all) either counts.
        phone: p.phone ?? p.mobilephone ?? null,
      },
    }
  } catch (error) {
    // Includes HubSpotConfigError (no token, or the staging kill switch). The
    // caller must carry on without the snapshot rather than lose the call.
    console.error('readContact threw', { contactId, error: error instanceof Error ? error.message : error })
    return { ok: false, error: 'HubSpot could not be reached' }
  }
}
