import { requireCapability } from '@/lib/authz'
import { activeOrganisation } from '@/lib/active-organisation.server'
import { loadPlaceholderContacts } from '@/lib/calls/placeholders'
import { officesForOrg } from '@/lib/organisations'
import { PlaceholderContactsClient } from './contacts-client'

// Read live from HubSpot: these records predate the Hub's call table, so they
// cannot come from it.
export const dynamic = 'force-dynamic'

export default async function PlaceholderContactsPage() {
  const auth = await requireCapability('calls.view')
  const org = await activeOrganisation(auth)
  const offices = org ? officesForOrg(org) : []
  const result = await loadPlaceholderContacts(offices)

  return (
    <PlaceholderContactsClient
      contacts={result.contacts}
      totalInPortal={result.total}
      error={result.error ?? null}
      canSeeNothing={offices.length === 0}
    />
  )
}
