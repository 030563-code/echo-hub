/**
 * The tax setup behind every invoice, in one place, for the organisation being
 * looked at.
 *
 * The USA: two things decide whether an invoice is right, and neither is
 * visible from the queue: the dispatch address each depot ships from (TaxJar's
 * origin) and the states TaxJar will actually collect for. The second is the
 * dangerous one, because a state that is missing from TaxJar returns zero tax
 * with no error rather than failing, so it has to be looked at rather than
 * assumed. Nexus is read live from TaxJar on every load, so this page cannot
 * drift from the account.
 *
 * France: Xero prices the TVA on a draft, so there are no states and no
 * TaxJar. Until 23 Sep 2026 this page showed France the USA's nexus table,
 * which described another company's tax. It now says which Xero tax type every
 * French line carries, which cases have no code yet, and where French invoices
 * dispatch from.
 */

import { AlertCircle } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { requireCapability } from '@/lib/authz'
import { activeOrganisation } from '@/lib/active-organisation.server'
import {
  DEPOT_FROM_ADDRESSES,
  US_DEPOTS,
  US_REGISTERED_STATES,
  type USDepot,
} from '@/lib/customer-invoice/constants'
import { invoicingProfile, type InvoicingProfile } from '@/lib/customer-invoice/invoicing-profile'
import { depotLabel } from '@/lib/depot-constants'
import { organisation, orgLabel } from '@/lib/organisations'
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
  const auth = await requireCapability(['invoicing.view', 'invoicing.manage'])
  // Whose setup. An organisation Xero prices gets its own page; everyone else
  // gets TaxJar's, which is what this page always was.
  const org = await activeOrganisation(auth)
  const profile = org ? invoicingProfile(org) : null
  // Checked first: Canada's tax will come from a Xero draft, but France's page
  // describes a tax type and EU cases that are France's alone, and TaxJar's
  // lists US states. Until 24 Sep 2026 Canada was shown the USA's.
  if (profile?.xeroNotConnected) return <NotConnectedTaxSetup profile={profile} />
  if (profile?.taxEngine === 'xero_draft') return <XeroDraftTaxSetup profile={profile} />
  return <TaxJarTaxSetup />
}

/** An organisation whose invoices open in the Hub but whose tax step does not
 *  exist yet. It says so, and shows the one thing already decided. */
function NotConnectedTaxSetup({ profile }: { profile: InvoicingProfile }) {
  const label = orgLabel(profile.org)
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Tax Setup</h1>
        <p className="text-gray-500 text-sm mt-1">How {label}&apos;s tax is priced, and where its invoices dispatch from.</p>
      </div>

      <Card className="bg-white border-gray-200 p-4 sm:p-6">
        <div className="flex items-start gap-2 text-sm text-gray-700">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
          <div className="space-y-1">
            <p className="font-medium text-gray-900">{profile.xeroNotConnected}</p>
            <p>
              Invoices open, edit and save in the Hub, and stop before the tax step. The Xero organisation is{' '}
              {organisation(profile.org).legalName}.
            </p>
          </div>
        </div>
      </Card>

      <Card className="bg-white border-gray-200 p-0 overflow-hidden">
        <div className="border-b border-gray-200 px-4 py-3">
          <h2 className="text-sm font-semibold text-gray-900">Dispatch addresses</h2>
          <p className="text-xs text-gray-500 mt-0.5">Printed on the invoice as where the goods left from.</p>
        </div>
        <table className="w-full text-sm">
          <tbody>
            {profile.depots.map((depot) => {
              const address = DEPOT_FROM_ADDRESSES[depot]
              return (
                <tr key={depot} className="border-b border-gray-100 last:border-0">
                  <td className="px-4 py-3 align-top w-48">
                    <span className="font-medium text-gray-900">{depotLabel(depot)}</span>
                    <span className="block text-xs text-gray-400">{depot}</span>
                  </td>
                  <td className="px-4 py-3 text-gray-600">
                    {address ? (
                      <>
                        {address.street}
                        <span className="block">
                          {address.city}
                          {address.state ? `, ${address.state}` : ''} {address.zip}
                        </span>
                      </>
                    ) : (
                      <span className="text-amber-700">Not configured yet.</span>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </Card>
    </div>
  )
}

/**
 * France. No live read: everything here is a decision already taken, and the
 * one live fact (the tax type's rate) is Xero's to apply on each draft.
 */
function XeroDraftTaxSetup({ profile }: { profile: InvoicingProfile }) {
  const legalName = organisation(profile.org).legalName
  const label = orgLabel(profile.org)
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Tax Setup</h1>
        <p className="text-gray-500 text-sm mt-1">
          How {label}&apos;s {profile.taxLabel} is priced, and where its invoices dispatch from.
        </p>
      </div>

      <Card className="bg-white border-gray-200 p-0 overflow-hidden">
        <div className="border-b border-gray-200 px-4 py-3">
          <h2 className="text-sm font-semibold text-gray-900">Tax engine</h2>
          <p className="text-xs text-gray-500 mt-0.5">Xero, on a draft invoice, before anyone approves anything.</p>
        </div>
        <dl className="divide-y divide-gray-100 text-sm">
          <div className="grid gap-1 px-4 py-3 sm:grid-cols-[12rem_1fr]">
            <dt className="font-medium text-gray-900">Xero organisation</dt>
            <dd className="text-gray-600">{legalName}</dd>
          </div>
          <div className="grid gap-1 px-4 py-3 sm:grid-cols-[12rem_1fr]">
            <dt className="font-medium text-gray-900">Tax type on every line</dt>
            <dd className="text-gray-600">
              {profile.xeroTaxType} <span className="text-gray-400">({profile.xeroTaxTypeName})</span>
            </dd>
          </div>
          <div className="grid gap-1 px-4 py-3 sm:grid-cols-[12rem_1fr]">
            <dt className="font-medium text-gray-900">What the Hub does</dt>
            <dd className="text-gray-600">
              Posts the invoice to {legalName} as a draft with that tax type on every line, reads the{' '}
              {profile.taxLabel} Xero worked out back onto the invoice, and refuses a priced line that comes back
              with none rather than treating it as exempt. Approving the invoice authorises that same draft.
            </dd>
          </div>
        </dl>
      </Card>

      <Card className="bg-white border-gray-200 p-0 overflow-hidden">
        <div className="border-b border-gray-200 px-4 py-3">
          <h2 className="text-sm font-semibold text-gray-900">Dispatch addresses</h2>
          <p className="text-xs text-gray-500 mt-0.5">
            Printed on the invoice as where the goods left from. {profile.taxLabel} does not depend on it.
          </p>
        </div>
        <table className="w-full text-sm">
          <tbody>
            {profile.depots.map((depot) => {
              const address = DEPOT_FROM_ADDRESSES[depot]
              return (
                <tr key={depot} className="border-b border-gray-100 last:border-0">
                  <td className="px-4 py-3 align-top w-48">
                    <span className="font-medium text-gray-900">{depotLabel(depot)}</span>
                    <span className="block text-xs text-gray-400">{depot}</span>
                  </td>
                  <td className="px-4 py-3 text-gray-600">
                    {address ? (
                      <>
                        {address.street}
                        <span className="block">
                          {address.city}
                          {address.state ? `, ${address.state}` : ''} {address.zip}
                        </span>
                      </>
                    ) : (
                      <span className="text-amber-700">
                        Not configured. The invoice prints no dispatch address until it is.
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
          <h2 className="text-sm font-semibold text-gray-900">Cases without a tax code</h2>
          <p className="text-xs text-gray-500 mt-0.5">
            Only domestic {profile.taxLabel} has a code in {legalName}&apos;s Xero today.
          </p>
        </div>
        <div className="flex items-start gap-2 px-4 py-4 text-sm text-gray-600">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
          <div className="space-y-2">
            <p>
              Three kinds of sale have no tax code in Xero yet, so an invoice for any of them would be priced at
              the domestic rate here. Until the accountant adds the codes, they are raised outside the Hub:
            </p>
            <ul className="list-disc space-y-1 pl-5">
              <li>a supply to a VAT-registered customer in another EU country (exempt, quoting their VAT number)</li>
              <li>an export outside the EU</li>
              <li>a domestic sale under the reverse charge</li>
            </ul>
          </div>
        </div>
      </Card>
    </div>
  )
}

/** The USA. Unchanged from the page this file was before France. */
async function TaxJarTaxSetup() {
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
                <tr className="border-b border-gray-200 text-left text-xs font-semibold uppercase tracking-wide text-gray-700">
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
