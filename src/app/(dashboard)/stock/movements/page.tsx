import { requireCapability } from '@/lib/authz'
import { loadMovements } from '@/lib/stock/board-data'
import MovementsBoard from './movements-board'

export const dynamic = 'force-dynamic'

export default async function MovementsPage() {
  await requireCapability(['stock.view', 'stock.edit'])
  const rows = await loadMovements({ limit: 500 })
  return <MovementsBoard rows={rows} />
}
