'use server'

import { createServerClient } from '@/lib/supabase/server'
import { hasAnyCapability } from '@/lib/authz'
import { COMPANY_CONTACTS_PAGE_SIZE } from '@/lib/hubspot-constants'

export interface CompanyContact {
  id: string
  properties: {
    firstname: string
    lastname: string
    email: string
    phone?: string
    jobtitle?: string
  }
}

export interface CompanyContactsResult {
  success: boolean
  data?: CompanyContact[]
  /** Total contacts at this company matching the current search — not the page size. */
  total?: number
  /** Cursor for the next page; absent when this is the last page. */
  nextAfter?: string
  error?: string
}

// HubSpot object ids are numeric. Rejected rather than sent if anything else.
const OBJECT_ID_RE = /^\d+$/

/**
 * One page of the contacts HubSpot has against a company, optionally filtered
 * by a search term.
 *
 * The manual-request flow used to make the rep search the whole contact
 * database by name after picking a company — slow, and it invites attaching
 * someone from a different account. This scopes to the company instead.
 *
 * Both the paging and the search run server-side on HubSpot: a search term
 * matches across EVERY contact at the company, not just the page on screen.
 * That matters because real accounts here carry four figures of contacts
 * (verified against the live portal), so a client-side filter over one loaded
 * page would quietly hide most of them and the rep would create a duplicate.
 *
 * `associatedcompanyid` is the contact's primary company association, which is
 * what the CRM search API can filter on.
 */
export async function getCompanyContacts(
  companyId: string,
  opts: { query?: string; after?: string; limit?: number } = {}
): Promise<CompanyContactsResult> {
  const supabase = await createServerClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { success: false, error: 'Unauthorized' }
  if (!(await hasAnyCapability(['quotes.view', 'quotes.create']))) {
    return { success: false, error: 'Forbidden: missing quotes capability' }
  }

  if (!OBJECT_ID_RE.test(companyId)) {
    return { success: false, error: 'Invalid company id' }
  }

  const accessToken = process.env.HUBSPOT_ACCESS_TOKEN
  if (!accessToken) return { success: false, error: 'HubSpot Token Missing' }

  const limit = Math.min(Math.max(opts.limit ?? COMPANY_CONTACTS_PAGE_SIZE, 1), 100)
  const query = (opts.query ?? '').trim()
  const after = (opts.after ?? '').trim()

  interface SearchBody {
    filterGroups: { filters: { propertyName: string; operator: string; value: string }[] }[]
    properties: string[]
    limit: number
    sorts?: { propertyName: string; direction: string }[]
    query?: string
    after?: string
  }

  const body: SearchBody = {
    filterGroups: [
      { filters: [{ propertyName: 'associatedcompanyid', operator: 'EQ', value: companyId }] },
    ],
    properties: ['firstname', 'lastname', 'email', 'phone', 'jobtitle'],
    limit,
    // Verified against the live API: the endpoint accepts a sort alongside a
    // text query, so keep results alphabetical whether or not the rep is
    // searching. A list that reorders itself as you type is hard to scan.
    sorts: [{ propertyName: 'lastname', direction: 'ASCENDING' }],
  }
  if (query) body.query = query
  if (after) body.after = after

  try {
    const response = await fetch('https://api.hubapi.com/crm/v3/objects/contacts/search', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      cache: 'no-store',
    })

    if (!response.ok) {
      const errorText = await response.text()
      console.error('HubSpot company-contacts search failed:', response.status, errorText)
      return { success: false, error: "Could not load this company's contacts." }
    }

    const data = await response.json()
    const contacts = ((data.results ?? []) as CompanyContact[]).map((c) => ({
      id: String(c.id),
      properties: {
        firstname: c.properties?.firstname ?? '',
        lastname: c.properties?.lastname ?? '',
        email: c.properties?.email ?? '',
        phone: c.properties?.phone,
        jobtitle: c.properties?.jobtitle,
      },
    }))

    return {
      success: true,
      data: contacts,
      total: typeof data.total === 'number' ? data.total : contacts.length,
      nextAfter: data.paging?.next?.after ? String(data.paging.next.after) : undefined,
    }
  } catch (error: unknown) {
    console.error('getCompanyContacts failed:', error)
    return { success: false, error: "Could not load this company's contacts." }
  }
}
