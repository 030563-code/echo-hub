import { requireCapability } from '@/lib/authz'
import { loadReconciliation } from '@/lib/stock/board-data'
import ReconciliationBoard from './reconciliation-board'

export const dynamic = 'force-dynamic'

export default async function ReconciliationPage() {
  await requireCapability(['stock.view', 'stock.edit'])
  const gaps = await loadReconciliation()
  return <ReconciliationBoard gaps={gaps} />
}
