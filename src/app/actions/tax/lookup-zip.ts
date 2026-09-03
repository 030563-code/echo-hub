'use server'

/**
 * Zip-driven address completion.
 *
 * HubSpot holds no delivery address at all (573 deal properties, the only
 * delivery one is a country-level enum), so the ship-to is typed by hand at
 * acceptance. A wrong zip is the dangerous case: it does not error, TaxJar
 * simply returns a different number and the customer is charged the wrong tax.
 *
 * GET /v2/rates/{zip} is the only TaxJar call that needs nothing but a zip, so
 * the rep types the zip (usually the one piece of geography a deal actually
 * carries) and the state, city and county come back to be confirmed. It is
 * free, read-only, and cannot be used to price anything.
 *
 * Shared deliberately: the same lookup serves the rep's acceptance dialog and
 * Dave's invoice editor, so both complete an address the same way.
 */

import { z } from 'zod'
import { getAuthorizedUser } from '@/lib/authz'
import { taxjarRatesForZip, TaxJarError, TaxJarConfigError } from '@/lib/taxjar'

const Input = z.object({ zip: z.string().min(1).max(12) })

export type ZipLookupResult =
  | {
      success: true
      zip: string
      state: string
      city: string | null
      county: string | null
      combinedRate: number
      freightTaxable: boolean
    }
  | { success: false; error: string }

export async function lookupZipJurisdiction(input: { zip: string }): Promise<ZipLookupResult> {
  const auth = await getAuthorizedUser()
  if (!auth.ok) return { success: false, error: auth.error }
  // Anyone who can set a delivery address or review an invoice may resolve a
  // zip. The data is public tax geography, but the call costs an API request,
  // so it is not left open to every signed-in user.
  const allowed =
    auth.capabilities.has('quotes.create') ||
    auth.capabilities.has('invoicing.manage') ||
    auth.capabilities.has('invoicing.view')
  if (!allowed) return { success: false, error: 'Not permitted to look up tax jurisdictions.' }

  const parsed = Input.safeParse(input)
  if (!parsed.success) return { success: false, error: 'Enter a zip code.' }

  try {
    const rate = await taxjarRatesForZip(parsed.data.zip)
    if (!rate) return { success: false, error: 'That is not a recognised US zip code.' }
    return {
      success: true,
      zip: rate.zip,
      state: rate.state,
      city: rate.city,
      county: rate.county,
      combinedRate: rate.combined_rate,
      freightTaxable: rate.freight_taxable,
    }
  } catch (err) {
    if (err instanceof TaxJarConfigError) {
      return { success: false, error: 'The TaxJar API token is not configured on the server.' }
    }
    if (err instanceof TaxJarError) {
      return { success: false, error: `TaxJar could not resolve that zip: ${err.message}` }
    }
    return { success: false, error: 'TaxJar could not be reached. Enter the address by hand.' }
  }
}
