/**
 * The tax setup behind every invoice, in one place.
 *
 * Two things decide whether an invoice is right, and neither is visible from
 * the queue: the dispatch address each depot ships from (TaxJar's origin) and
 * the states TaxJar will actually collect for. The second is the dangerous
 * one, because a state that is missing from TaxJar returns zero tax with no
 * error rather than failing, so it has to be looked at rather than assumed.
 *
 * Nexus is read live from TaxJar on every load, so this page cannot drift from
 * the account.
 */

import { AlertTriangle, CheckCircle2, MapPin } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { requireCapability } from '@/lib/authz'
import {
  DEPOT_FROM_ADDRESSES,
  US_DEPOTS,
  US_REGISTERED_STATES,
  type USDepot,
} from '@/lib/customer-invoice/constants'
import { taxjarNexusRegions } from '@/lib/taxjar'

export const dynamic = 'force-dynamic'

const STATE_NAMES: Record<string, string> = {
  CA: 'California',
  IL: 'Illinois',
  MA: 'Massachusetts',
  MD: 'Maryland',
  MN: 'Minnesota',
  SC: 'South Carolina',
  TN: 'Tennessee',
  VA: 'Virginia',
}

export default async function TaxSetupPage() {
  await requireCapability(['invoicing.view', 'invoicing.manage'])

  let nexus: string[] | null = null
  let nexusError: string | null = null
  try {
    nexus = await taxjarNexusRegions()
  } catch (err) {
    nexusError = err instanceof Error ? err.message : 'TaxJar could not be reached.'
  }

  const live = new Set(nexus ?? [])
  const held = US_REGISTERED_STATES.filter((s) => !live.has(s))
  const extra = (nexus ?? []).filter((s) => !US_REGISTERED_STATES.includes(s))

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-gray-900">Tax setup</h1>
        <p className="mt-1 text-sm text-gray-500">
          Where invoices ship from, and which states TaxJar collects for. Read live from TaxJar.
        </p>
      </div>

      <Card className="p-4 sm:p-6">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500 mb-1">Dispatch addresses</h2>
        <p className="text-xs text-gray-500 mb-4">
          TaxJar&apos;s origin for each shipment, and the destination too when an order is collected.
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          {US_DEPOTS.map((depot: USDepot) => {
            const address = DEPOT_FROM_ADDRESSES[depot]
            return (
              <div key={depot} className="rounded-md border border-gray-200 p-3">
                <p className="text-sm font-medium text-gray-900">{depot}</p>
                {address ? (
                  <p className="mt-1 flex items-start gap-1.5 text-sm text-gray-600">
                    <MapPin className="mt-0.5 h-3.5 w-3.5 shrink-0 text-gray-400" />
                    <span>
                      {address.street}
                      <br />
                      {address.city}, {address.state} {address.zip}
                    </span>
                  </p>
                ) : (
                  <p className="mt-1 text-sm text-amber-700">
                    Not configured. Tax cannot be calculated for anything shipping from here.
                  </p>
                )}
              </div>
            )
          })}
        </div>
      </Card>

      <Card className="p-4 sm:p-6">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500 mb-1">
          States TaxJar collects for
        </h2>
        <p className="text-xs text-gray-500 mb-4">
          A state Echo Barrier is registered in but that is switched off in TaxJar returns zero tax without
          erroring. Calculation refuses those rather than under-collecting.
        </p>

        {nexusError ? (
          <p className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800">
            Could not read nexus from TaxJar: {nexusError}
          </p>
        ) : (
          <>
            <div className="flex flex-wrap gap-2">
              {[...live].sort().map((code) => (
                <span
                  key={code}
                  className="inline-flex items-center gap-1.5 rounded-full bg-green-50 px-3 py-1 text-sm text-green-800"
                >
                  <CheckCircle2 className="h-3.5 w-3.5" />
                  {STATE_NAMES[code] ?? code}
                </span>
              ))}
            </div>

            {held.length > 0 && (
              <div className="mt-4 rounded-md border border-amber-200 bg-amber-50 p-3">
                <p className="flex items-center gap-1.5 text-sm font-medium text-amber-900">
                  <AlertTriangle className="h-4 w-4" />
                  Registered but not collecting: {held.map((c) => STATE_NAMES[c] ?? c).join(', ')}
                </p>
                <p className="mt-1 text-xs text-amber-800">
                  Invoices delivered to, or collected in, {held.length === 1 ? 'this state' : 'these states'} are
                  blocked at calculation. Switch the state on in the TaxJar account to clear it.
                  {held.includes('MD') && (
                    <> Baltimore (US-BAL) sits in Jessup, Maryland, so every order collected there is a Maryland sale.</>
                  )}
                </p>
              </div>
            )}

            {extra.length > 0 && (
              <p className="mt-4 text-xs text-gray-500">
                Also live in TaxJar but not in the registration list held by this app:{' '}
                {extra.join(', ')}. Worth reconciling.
              </p>
            )}
          </>
        )}
      </Card>
    </div>
  )
}
