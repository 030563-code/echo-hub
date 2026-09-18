import Link from 'next/link'
import { notFound } from 'next/navigation'
import { ArrowLeft } from 'lucide-react'
import { requireCapability } from '@/lib/authz'
import { loadFactoryDocuments, loadFactoryOrder } from '@/lib/factory/orders'
import { displayPoNumber } from '@/lib/po-number'
import { factoryStatus, factoryStatusLabel } from '@/lib/factory/status'
import { factoryLocale } from '@/lib/factory/locale.server'
import { factoryDate, fill, strings } from '@/lib/factory/strings'
import { OrderSteps } from './order-steps'

export const dynamic = 'force-dynamic'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * One purchase order, and the three things to do with it in order.
 *
 * An order that does not exist, was never sent, or is not a manufacturing leg
 * all answer the same way: notFound. The page never says which, because the
 * difference is only interesting to somebody guessing ids.
 */
export default async function FactoryOrderPage({ params }: { params: Promise<{ id: string }> }) {
  await requireCapability(['factory.view', 'factory.update'])
  const { id } = await params
  if (!UUID.test(id)) notFound()

  const order = await loadFactoryOrder(id)
  if (!order) notFound()
  // Only the files somebody here ticked for them. The loader asks the same two
  // questions the download action does.
  const documents = await loadFactoryDocuments(id)

  const locale = await factoryLocale()
  const t = strings(locale)
  const status = factoryStatus(order)
  const shortages = (order.short_materials ?? []).flatMap((line) => line.short ?? [])

  return (
    <div>
      <Link href="/factory" className="mb-4 inline-flex items-center gap-1.5 text-sm text-gray-600 hover:text-gray-900">
        <ArrowLeft className="h-4 w-4" />
        {t.backToOrders}
      </Link>

      <div className="mb-6 flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-bold text-gray-900">
          {fill(t.orderTitle, { number: displayPoNumber(order.po_number) })}
        </h1>
        <span className="rounded-full border border-gray-200 bg-gray-50 px-2.5 py-0.5 text-xs font-semibold text-gray-700">
          {factoryStatusLabel(status, locale)}
        </span>
      </div>

      {order.sent_at && (
        <p className="-mt-3 mb-6 text-sm text-gray-600">
          {fill(t.sentOn, {
            date: factoryDate(order.sent_at, locale, { day: 'numeric', month: 'long', year: 'numeric' }),
          })}
        </p>
      )}

      <div className="overflow-hidden rounded-lg border border-gray-200">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-gray-50 text-[11px] uppercase tracking-wider text-gray-500">
              <th className="px-4 py-2.5 text-left font-medium">{t.thProduct}</th>
              <th className="px-4 py-2.5 text-right font-medium">{t.thQuantity}</th>
            </tr>
          </thead>
          <tbody>
            {order.lines.map((line, i) => (
              <tr key={i} className="border-t border-gray-100">
                {/* The SKU is our internal database code and means nothing to a
                    factory. It is the fallback for a line with no product name,
                    which would otherwise render an empty row. */}
                <td className="px-4 py-2.5 text-gray-900">{line.product_name || line.sku}</td>
                <td className="px-4 py-2.5 text-right tabular-nums text-gray-900">{line.quantity}</td>
              </tr>
            ))}
            {order.lines.length === 0 && (
              <tr>
                <td colSpan={2} className="px-4 py-8 text-center text-gray-400">
                  {t.orderHasNoLines}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {shortages.length > 0 && (
        <div className="mt-6 rounded-lg border-l-4 border-amber-400 bg-amber-50 p-4">
          <h2 className="text-xs font-bold uppercase tracking-wider text-amber-900">{t.shortagesTitle}</h2>
          <p className="mt-1 text-sm text-amber-900">{t.shortagesIntro}</p>
          <table className="mt-3 w-full text-sm">
            <thead>
              <tr className="text-[11px] uppercase tracking-wider text-amber-800">
                <th className="py-1 text-left font-medium">{t.thMaterial}</th>
                <th className="py-1 text-right font-medium">{t.thNeeded}</th>
                <th className="py-1 text-right font-medium">{t.thInStock}</th>
                <th className="py-1 text-right font-medium">{t.thShort}</th>
              </tr>
            </thead>
            <tbody className="text-amber-900">
              {shortages.map((s, i) => (
                <tr key={i} className="border-t border-amber-200">
                  <td className="py-1.5">{s.description || s.code}</td>
                  <td className="py-1.5 text-right tabular-nums">{s.need}</td>
                  <td className="py-1.5 text-right tabular-nums">{s.have}</td>
                  <td className="py-1.5 text-right font-semibold tabular-nums">{s.short}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <OrderSteps
        poId={order.po_id}
        poNumber={displayPoNumber(order.po_number)}
        estStart={order.est_start}
        estFinish={order.est_finish}
        confirmedAt={order.confirmed_at}
        finishedAt={order.finished_at}
        documents={documents}
        locale={locale}
      />
    </div>
  )
}
