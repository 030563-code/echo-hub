import { requireCapability } from '@/lib/authz'
import { StockNav } from './stock-nav'

// Gates the whole /stock subtree: stock.view reads the board, stock.edit also
// records counts and adjustments. Each page checks for itself as well; the
// nav only decides what is shown.
export default async function StockLayout({ children }: { children: React.ReactNode }) {
  await requireCapability(['stock.view', 'stock.edit'])
  return (
    <div className="max-w-7xl mx-auto">
      <div className="mb-2">
        <h1 className="text-2xl font-bold text-gray-900">Stock</h1>
        <p className="mt-1 text-sm text-gray-500">
          On hand, committed and inbound, from s.r.o. to the depots. Every change is a movement.
        </p>
      </div>
      <StockNav />
      {children}
    </div>
  )
}
