import { requireCapability } from '@/lib/authz'
import { activeOrganisation } from '@/lib/active-organisation.server'
import { warehousesForOrg } from '@/lib/organisations'
import { NoOrganisationCard } from '@/components/organisations/no-organisation-card'
import { loadReconciliation } from '@/lib/stock/board-data'
import ReconciliationBoard from './reconciliation-board'

export const dynamic = 'force-dynamic'

export default async function ReconciliationPage() {
  const auth = await requireCapability(['stock.view', 'stock.edit'])
  // A ledger gap is an event that should have moved stock and did not: an
  // invoice sent, a container booked, a delivery logged. Events carry no
  // warehouse of their own, so the list is not split further than "does this
  // organisation hold stock at all"; a person with none has no ledger to check.
  const org = await activeOrganisation(auth)
  if (!org) return <NoOrganisationCard title="Reconciliation" what="a stock ledger" />
  if (warehousesForOrg(org).length === 0) return <NoOrganisationCard title="Reconciliation" what="stock" org={org} />
  const gaps = await loadReconciliation()
  return <ReconciliationBoard gaps={gaps} />
}
