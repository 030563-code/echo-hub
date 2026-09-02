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

import { AlertCircle } from 'lucide-react'
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

const DEPOT_NAMES: Record<USDepot, string> = {
  'US-BAL': 'Baltimore',
  'US-SBD': 'San Bernardino',
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
  const rows = [...new Set([...US_REGISTERED_STATES, ...(nexus ?? [])])].sort((a, b) =>
    (STATE_NAMES[a] ?? a).localeCompare(STATE_NAMES[b] ?? b),
  )
  const held = US_REGISTERED_STATES.filter((s) => !live.has(s))

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Tax Setup</h1>
        <p className="text-gray-500 text-sm mt-1">
          Where invoices ship from, and which states TaxJar collects for. Read live from TaxJar.
        </p>
      </div>

      <Card className="bg-white border-gray-200 p-0 overflow-hidden">
        <div className="border-b border-gray-200 px-4 py-3">
          <h2 className="text-sm font-semibold text-gray-900">Dispatch addresses</h2>
          <p className="text-xs text-gray-500 mt-0.5">
            TaxJar&apos;s origin for each shipment, and the destination too when an order is collected.
          </p>
        </div>
        <table className="w-full text-sm">
          <tbody>
            {US_DEPOTS.map((depot: USDepot) => {
              const address = DEPOT_FROM_ADDRESSES[depot]
              return (
                <tr key={depot} className="border-b border-gray-100 last:border-0">
                  <td className="px-4 py-3 align-top w-48">
                    <span className="font-medium text-gray-900">{DEPOT_NAMES[depot]}</span>
                    <span className="block text-xs text-gray-400">{depot}</span>
                  </td>
                  <td className="px-4 py-3 text-gray-600">
                    {address ? (
                      <>
                        {address.street}
                        <span className="block">
                          {address.city}, {address.state} {address.zip}
                        </span>
                      </>
                    ) : (
                      <span className="text-amber-700">
                        Not configured. Nothing shipping from here can be taxed.
                      </span>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </Card>

      <Card className="bg-white border-gray-200 p-0 overflow-hidden">
        <div className="border-b border-gray-200 px-4 py-3">
          <h2 className="text-sm font-semibold text-gray-900">Sales tax states</h2>
          <p className="text-xs text-gray-500 mt-0.5">
            A state Echo Barrier is registered in but that TaxJar is not collecting for returns zero tax
            without erroring. Calculation refuses those rather than under-collecting.
          </p>
        </div>

        {nexusError ? (
          <div className="flex items-start gap-2 px-4 py-4 text-sm text-gray-600">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-gray-400" />
            <span>Could not read nexus from TaxJar: {nexusError}</span>
          </div>
        ) : (
          <>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-200 text-left text-xs uppercase tracking-wide text-gray-500">
                  <th className="px-4 py-3 font-medium">State</th>
                  <th className="px-4 py-3 font-medium">Registered</th>
                  <th className="px-4 py-3 font-medium">Collecting in TaxJar</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((code) => {
                  const registered = US_REGISTERED_STATES.includes(code)
                  const collecting = live.has(code)
                  return (
                    <tr key={code} className="border-b border-gray-100 last:border-0">
                      <td className="px-4 py-2.5 font-medium text-gray-900">{STATE_NAMES[code] ?? code}</td>
                      <td className="px-4 py-2.5 text-gray-600">{registered ? 'Yes' : 'No'}</td>
                      <td className="px-4 py-2.5">
                        {collecting ? (
                          <span className="text-gray-600">Yes</span>
                        ) : (
                          <span className={registered ? 'font-medium text-amber-700' : 'text-gray-400'}>No</span>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>

            {held.length > 0 && (
              <div className="border-t border-gray-200 px-4 py-3 text-xs text-gray-600">
                <span className="font-medium text-gray-900">
                  {held.map((c) => STATE_NAMES[c] ?? c).join(', ')} {held.length === 1 ? 'is' : 'are'} registered
                  but not collecting.
                </span>{' '}
                Invoices delivered to, or collected in, {held.length === 1 ? 'that state' : 'those states'} are
                blocked at calculation. Switching the state on in TaxJar clears it.
                {held.includes('MD') && (
                  <> Baltimore sits in Jessup, Maryland, so every order collected there is a Maryland sale.</>
                )}
              </div>
            )}
          </>
        )}
      </Card>
    </div>
  )
}
