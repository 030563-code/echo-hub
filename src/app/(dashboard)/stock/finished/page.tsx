import { requireCapability } from '@/lib/authz'
import { activeOrganisation } from '@/lib/active-organisation.server'
import { warehousesForOrg } from '@/lib/organisations'
import { NoOrganisationCard } from '@/components/organisations/no-organisation-card'
import { loadFinishedBoard } from '@/lib/stock/board-data'
import FinishedBoard from './finished-board'

export const dynamic = 'force-dynamic'

export default async function FinishedGoodsPage() {
  const auth = await requireCapability(['stock.view', 'stock.edit'])
  const canEdit = auth.capabilities.has('stock.edit')
  // The organisation being looked at decides the warehouses, in the query. An
  // organisation that holds no stock (Group, Australia) is told so.
  const org = await activeOrganisation(auth)
  if (!org) return <NoOrganisationCard title="Finished goods" what="stock" />
  const warehouses = warehousesForOrg(org)
  if (warehouses.length === 0) return <NoOrganisationCard title="Finished goods" what="stock" org={org} />
  const rows = await loadFinishedBoard(new Date(), warehouses)
  return <FinishedBoard rows={rows} canEdit={canEdit} />
}
