import { AlertTriangle } from 'lucide-react'
import { requireCapability } from '@/lib/authz'
import { loadFactoryStock } from '@/lib/factory/stock'
import { loadFactoryCapability } from '@/lib/factory/capability'
import { feedIsFrozen, feedIsStale } from '@/lib/factory/status'
import { factoryLocale } from '@/lib/factory/locale.server'
import { FACTORY_DATE_LOCALE, factoryDate, fill, strings } from '@/lib/factory/strings'
import { FactoryStockTable } from './factory-stock-table'
import { FactoryCapabilityTable } from './factory-capability-table'

export const dynamic = 'force-dynamic'

/**
 * The manufacturer's own material stock, read back to them, and above it what
 * that stock lets them build against what we will need.
 *
 * Dean, 16 Sep 2026: "the stock tab (Only Bamida stock) ... just use the Bamida
 * stock level from API not ours". So the material list is their feed and
 * nothing else: not the Hub's ledger, not what s.r.o. holds, not what we think
 * they should have.
 *
 * Their CEO, 18 Sep 2026: "Minimum stock levels. It is crucial for the system to
 * be able to alert the warehouse when the stock of any material runs low. Only
 * you can configure this. We do not know the volume of orders or their
 * priorities." The product table is that: our requirement, their capability,
 * and the materials our requirement would draw beside each row of their feed.
 *
 * Two banners, for two different failures. Stale means the sync has not run;
 * frozen means it ran and nothing moved, which for a working factory means the
 * feed has stopped. Frozen also hides the product table, because a capability
 * figure on a frozen number is a confident lie.
 */
export default async function FactoryStockPage() {
  await requireCapability(['factory.view', 'factory.update'])
  const [{ rows, newestSyncAt, newestChangeAt }, locale] = await Promise.all([
    loadFactoryStock(),
    factoryLocale(),
  ])
  const t = strings(locale)
  const stale = feedIsStale(newestSyncAt)
  const frozen = rows.length > 0 && feedIsFrozen(newestChangeAt)
  const capability = frozen ? null : await loadFactoryCapability(rows)

  const lines = rows.map((row) => ({ ...row, need: capability?.needs.get(row.ns_number) ?? null }))
  const longDate = (v: string | null) =>
    factoryDate(v, locale, { day: 'numeric', month: 'long', year: 'numeric' })

  return (
    <div>
      {!frozen && (
        <section className="mb-10">
          <h1 className="text-2xl font-bold text-gray-900">{t.capabilityTitle}</h1>
          <p className="mt-1 text-sm text-gray-600">
            {t.capabilityIntro}
            {capability?.runDate && <> {fill(t.capabilityRun, { date: longDate(capability.runDate) })}</>}
          </p>
          <div className="mt-4">
            <FactoryCapabilityTable rows={capability?.products ?? []} locale={locale} />
          </div>
        </section>
      )}

      <div className="mb-6">
        <h2 className="text-2xl font-bold text-gray-900">{t.stockTitle}</h2>
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
          {newestChangeAt && <> {fill(t.stockUnchangedSince, { date: longDate(newestChangeAt) })}</>}
        </p>
      </div>

      {frozen && (
        <div className="mb-6 flex items-start gap-3 rounded-lg border-l-4 border-red-400 bg-red-50 p-4">
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-red-600" />
          <div className="text-sm text-red-900">
            <p>{fill(t.stockFrozen, { date: longDate(newestChangeAt) })}</p>
            <p className="mt-2">{fill(t.capabilityFrozen, { date: longDate(newestChangeAt) })}</p>
          </div>
        </div>
      )}

      {stale && rows.length > 0 && (
        <div className="mb-6 flex items-start gap-3 rounded-lg border-l-4 border-amber-400 bg-amber-50 p-4">
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-600" />
          <p className="text-sm text-amber-900">{t.stockStale}</p>
        </div>
      )}

      <FactoryStockTable rows={lines} locale={locale} />
    </div>
  )
}
