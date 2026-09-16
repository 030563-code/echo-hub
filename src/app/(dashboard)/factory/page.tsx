import { requireCapability } from '@/lib/authz'
import { loadFactoryOrders } from '@/lib/factory/orders'
import { factoryLocale } from '@/lib/factory/locale.server'
import { strings } from '@/lib/factory/strings'
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
  const [orders, locale] = await Promise.all([loadFactoryOrders(), factoryLocale()])
  const t = strings(locale)

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">{t.ordersTitle}</h1>
        <p className="mt-1 text-sm text-gray-600">{t.ordersIntro}</p>
      </div>
      <FactoryOrdersTable rows={orders} locale={locale} />
    </div>
  )
}
