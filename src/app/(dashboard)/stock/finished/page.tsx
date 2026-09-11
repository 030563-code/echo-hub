import { requireCapability } from '@/lib/authz'
import { loadFinishedBoard } from '@/lib/stock/board-data'
import FinishedBoard from './finished-board'

export const dynamic = 'force-dynamic'

export default async function FinishedGoodsPage() {
  const auth = await requireCapability(['stock.view', 'stock.edit'])
  const canEdit = auth.capabilities.has('stock.edit')
  const rows = await loadFinishedBoard()
  return <FinishedBoard rows={rows} canEdit={canEdit} />
}
