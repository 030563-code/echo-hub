import { AlertTriangle } from 'lucide-react'
import { requireCapability } from '@/lib/authz'
import { loadFactoryStock } from '@/lib/factory/stock'
import { feedIsStale } from '@/lib/factory/status'
import { factoryLocale } from '@/lib/factory/locale.server'
import { FACTORY_DATE_LOCALE, fill, strings } from '@/lib/factory/strings'
import { FactoryStockTable } from './factory-stock-table'

export const dynamic = 'force-dynamic'

/**
 * The manufacturer's own material stock, read back to them.
 *
 * Dean, 16 Sep 2026: "the stock tab (Only Bamida stock) ... just use the Bamida
 * stock level from API not ours". So this is their feed and nothing else: not
 * the Hub's ledger, not what s.r.o. holds, not what we think they should have.
 */
export default async function FactoryStockPage() {
  await requireCapability(['factory.view', 'factory.update'])
  const [{ rows, newestSyncAt }, locale] = await Promise.all([loadFactoryStock(), factoryLocale()])
  const t = strings(locale)
  const stale = feedIsStale(newestSyncAt)

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">{t.stockTitle}</h1>
        <p className="mt-1 text-sm text-gray-600">
          {t.stockIntro}
          {newestSyncAt && (
            <>
              {' '}
              {fill(t.stockUpdated, {
                date: new Date(newestSyncAt).toLocaleString(FACTORY_DATE_LOCALE[locale], {
                  day: 'numeric',
                  month: 'short',
                  hour: '2-digit',
                  minute: '2-digit',
                }),
              })}
            </>
          )}
        </p>
      </div>

      {stale && rows.length > 0 && (
        <div className="mb-6 flex items-start gap-3 rounded-lg border-l-4 border-amber-400 bg-amber-50 p-4">
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-600" />
          <p className="text-sm text-amber-900">{t.stockStale}</p>
        </div>
      )}

      <FactoryStockTable rows={rows} locale={locale} />
    </div>
  )
}
