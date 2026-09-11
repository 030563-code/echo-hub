import { requireCapability } from '@/lib/authz'
import { loadMaterialsBoard } from '@/lib/stock/board-data'
import MaterialsBoard from './materials-board'

export const dynamic = 'force-dynamic'

export default async function MaterialsPage() {
  const auth = await requireCapability(['stock.view', 'stock.edit'])
  const canEdit = auth.capabilities.has('stock.edit')
  const rows = await loadMaterialsBoard()
  return <MaterialsBoard rows={rows} canEdit={canEdit} />
}
