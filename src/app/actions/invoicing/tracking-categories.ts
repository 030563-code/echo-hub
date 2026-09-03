'use server'

/**
 * The tracking categories a rep can choose from, for the line-item pickers.
 *
 * Read from Xero on demand through n8n, then narrowed to ACTIVE categories and
 * ACTIVE options. Returns an empty list rather than an error when the
 * organisation uses no tracking at all, because that is a valid configuration
 * and not a failure the rep should be shown.
 */

import { getAuthorizedUser } from '@/lib/authz'
import { xeroTrackingCategories } from '@/lib/xero-hub'
import { parseTrackingCategories, type TrackingCategory } from '@/lib/customer-invoice/tracking'

export type TrackingCategoriesResult =
  | { success: true; categories: TrackingCategory[] }
  | { success: false; error: string }

export async function getTrackingCategories(): Promise<TrackingCategoriesResult> {
  const auth = await getAuthorizedUser()
  if (!auth.ok) return { success: false, error: auth.error }
  if (!(auth.capabilities.has('invoicing.view') || auth.capabilities.has('invoicing.manage'))) {
    return { success: false, error: 'Not permitted to view invoicing.' }
  }

  const res = await xeroTrackingCategories()
  if (!res.ok) return { success: false, error: res.error }
  return { success: true, categories: parseTrackingCategories(res.data) }
}
