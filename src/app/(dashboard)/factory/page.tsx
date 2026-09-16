import { requireCapability } from '@/lib/authz'
import { loadFactoryOrders } from '@/lib/factory/orders'
import { FactoryOrdersTable } from './factory-orders-table'

export const dynamic = 'force-dynamic'

/**
 * Every purchase order sent to the manufacturer, newest first.
 *
 * Dean, 16 Sep 2026: "The manufacturer really needs their own interface where
 * they can see all their POs and click on them and update instead of having to
 * look for the link to each one via email."
 */
export default async function FactoryOrdersPage() {
  await requireCapability(['factory.view', 'factory.update'])
  const orders = await loadFactoryOrders()

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Manufacturing</h1>
        <p className="mt-1 text-sm text-gray-600">
          Purchase orders sent to you. Open one to download it, confirm it with your dates, and mark
          it finished when you invoice.
        </p>
      </div>
      <FactoryOrdersTable rows={orders} />
    </div>
  )
}
