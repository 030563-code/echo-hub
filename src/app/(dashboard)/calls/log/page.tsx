import { requireCapability } from '@/lib/authz'
import { createAdminClient } from '@/lib/supabase/admin'
import { loadCallsBoard } from '@/lib/calls/board-data'
import { officesForViewer } from '@/lib/calls/offices'
import { CallLogClient } from './log-client'

// Every row is a live read of the Hub's own call table, and a rep linking a
// call has to see the result immediately.
export const dynamic = 'force-dynamic'

export default async function CallLogPage() {
  const auth = await requireCapability('calls.view')
  const offices = officesForViewer(auth.profile.pipeline_id, auth.profile.is_super_admin)
  const board = await loadCallsBoard(createAdminClient(), offices)

  return <CallLogClient calls={board.calls} canSeeNothing={offices.length === 0} />
}
