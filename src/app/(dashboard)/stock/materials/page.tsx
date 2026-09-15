import { requireCapability } from '@/lib/authz'
import { activeOrganisation } from '@/lib/active-organisation.server'
import { warehousesForOrg } from '@/lib/organisations'
import { SRO_WAREHOUSE } from '@/lib/stock/warehouses'
import { NoOrganisationCard } from '@/components/organisations/no-organisation-card'
import { loadMaterialsBoard } from '@/lib/stock/board-data'
import MaterialsBoard from './materials-board'

export const dynamic = 'force-dynamic'

export default async function MaterialsPage() {
  const auth = await requireCapability(['stock.view', 'stock.edit'])
  const canEdit = auth.capabilities.has('stock.edit')
  // Raw materials sit in Kosice and nowhere else, so this board belongs to the
  // organisation holding the s.r.o. warehouse.
  const org = await activeOrganisation(auth)
  if (!org) return <NoOrganisationCard title="Raw materials" what="materials" />
  if (!warehousesForOrg(org).includes(SRO_WAREHOUSE)) {
    return <NoOrganisationCard title="Raw materials" what="raw materials" org={org} />
  }
  const rows = await loadMaterialsBoard()
  return <MaterialsBoard rows={rows} canEdit={canEdit} />
}
