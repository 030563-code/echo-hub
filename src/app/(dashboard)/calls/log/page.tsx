import { requireCapability } from '@/lib/authz'
import { createAdminClient } from '@/lib/supabase/admin'
import { activeOrganisation } from '@/lib/active-organisation.server'
import { loadCallsBoard } from '@/lib/calls/board-data'
import { officesForOrg } from '@/lib/organisations'
import { CallLogClient } from './log-client'

// Every row is a live read of the Hub's own call table, and a rep linking a
// call has to see the result immediately.
export const dynamic = 'force-dynamic'

export default async function CallLogPage() {
  const auth = await requireCapability('calls.view')
  // The organisation being looked at decides the offices, and the offices go
  // into the query. No organisation, or one with no phone office, means no
  // calls, said so on the page rather than shown as everyone's.
  const org = await activeOrganisation(auth)
  const offices = org ? officesForOrg(org) : []
  const board = await loadCallsBoard(createAdminClient(), offices)

  return <CallLogClient calls={board.calls} canSeeNothing={offices.length === 0} />
}
