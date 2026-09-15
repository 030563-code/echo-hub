import { requireCapability } from '@/lib/authz'
import { activeOrganisation } from '@/lib/active-organisation.server'
import { warehousesForOrg } from '@/lib/organisations'
import { NoOrganisationCard } from '@/components/organisations/no-organisation-card'
import { loadMovements } from '@/lib/stock/board-data'
import MovementsBoard from './movements-board'

export const dynamic = 'force-dynamic'

export default async function MovementsPage() {
  const auth = await requireCapability(['stock.view', 'stock.edit'])
  const org = await activeOrganisation(auth)
  if (!org) return <NoOrganisationCard title="Movements" what="stock movements" />
  const warehouses = warehousesForOrg(org)
  if (warehouses.length === 0) return <NoOrganisationCard title="Movements" what="stock movements" org={org} />
  const rows = await loadMovements({ warehouses, limit: 500 })
  return <MovementsBoard rows={rows} />
}
