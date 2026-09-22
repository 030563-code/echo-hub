import Link from 'next/link'
import { notFound } from 'next/navigation'
import { ArrowLeft, AlertTriangle } from 'lucide-react'
import { requireCapability } from '@/lib/authz'
import { loadFactoryStock } from '@/lib/factory/stock'
import { loadFactoryCapability } from '@/lib/factory/capability'
import { productDraw } from '@/lib/factory/capability-math'
import { feedIsFrozen } from '@/lib/factory/status'
import { factoryLocale } from '@/lib/factory/locale.server'
import { factoryDate, fill, strings } from '@/lib/factory/strings'

export const dynamic = 'force-dynamic'

/**
 * One product, material by material: the arithmetic behind "you can build N".
 *
 * Dean, 18 Sep 2026: "It would be useful to show Bamida a breakdown of this
 * calculation too based on THEIR material and not reveal some of our internal
 * information on our own material and quotes in the system and those
 * calculations."
 *
 * So everything on this page is theirs. Their parts list, their pallet size,
 * their stock. The only figure of ours is the single quantity we want built,
 * which they already have on the order, and where that quantity comes from is
 * not shown, not hinted at, and not loaded. Prices appear nowhere: neither
 * theirs nor our material cost, because this page is about quantities.
 *
 * With no forecast for a product the page still works, and shows what one full
 * pallet consumes. That is the number a warehouse can actually plan against.
 */
export default async function FactoryProductPage({
  params,
  searchParams,
}: {
  params: Promise<{ fg: string }>
  searchParams: Promise<{ qty?: string }>
}) {
  await requireCapability(['factory.view', 'factory.update'])
  const [{ fg }, { qty: qtyParam }, locale] = await Promise.all([params, searchParams, factoryLocale()])
  const t = strings(locale)

  const { rows, newestChangeAt } = await loadFactoryStock()
  const { products, components } = await loadFactoryCapability(rows)
  const product = products.find((p) => p.fgCode === fg)
  if (!product) notFound()

  const n = (v: number) =>
    v.toLocaleString(locale === 'sk' ? 'sk-SK' : 'en-GB', { maximumFractionDigits: 2 })
  const stockByCode = new Map(rows.map((r) => [r.ns_number, Math.max(0, Number(r.quantity ?? 0))]))
  const unitByCode = new Map(rows.map((r) => [r.ns_number, r.unit]))

  // The quantity the table is worked out for: what we asked for, what they
  // typed into the box, or one pallet when we have asked for nothing.
  const asked = Number(qtyParam)
  const typed = Number.isFinite(asked) && asked > 0 ? Math.min(Math.floor(asked), 1_000_000) : null
  const fallback = product.palletSize && product.palletSize > 0 ? product.palletSize : 1
  const qty = typed ?? product.requirement ?? fallback
  const pallets = product.palletSize && product.palletSize > 0 ? Math.ceil(qty / product.palletSize) : 0
  const draw = productDraw(product, components, stockByCode, qty)
  const frozen = rows.length > 0 && feedIsFrozen(newestChangeAt)

  return (
    <div>
      <Link
        href="/factory/stock"
        className="mb-4 inline-flex items-center gap-1.5 text-sm text-gray-600 hover:text-gray-900"
      >
        <ArrowLeft className="h-4 w-4" />
        {t.bdBack}
      </Link>

      <h1 className="text-2xl font-bold text-gray-900">{product.productName}</h1>
      <p className="mt-1 max-w-3xl text-sm text-gray-600">{t.bdIntro}</p>

      {frozen && (
        <div className="mt-4 flex items-start gap-3 rounded-lg border-l-4 border-red-400 bg-red-50 p-4">
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-red-600" />
          <p className="text-sm text-red-900">
            {fill(t.capabilityFrozen, {
              date: factoryDate(newestChangeAt, locale, { day: 'numeric', month: 'long', year: 'numeric' }),
            })}
          </p>
        </div>
      )}

      <div className="mt-6 rounded-lg border border-gray-200 bg-gray-50 p-4">
        <p className="text-sm font-medium text-gray-900">
          {typed !== null
            ? fill(t.bdForTyped, { qty: n(qty) })
            : product.requirement !== null
              ? fill(t.bdForRequirement, { qty: n(qty) })
              : fill(t.bdForPallet, { qty: n(qty) })}
        </p>
        <p className="mt-1 text-sm text-gray-600">
          {product.palletSize && product.palletSize > 0
            ? fill(t.bdRule, { qty: n(qty), pallets: n(pallets), palletSize: n(product.palletSize) })
            : fill(t.bdRuleNoPallet, { qty: n(qty) })}
        </p>
        <p className="mt-2 text-sm text-gray-900">
          {product.maxBuildable === null || !product.bindingDesc
            ? t.bdCeilingUnknown
            : fill(t.bdCeiling, { material: product.bindingDesc, max: n(product.maxBuildable) })}
        </p>

        {/* A plain GET form, so it works with no JavaScript at all. */}
        <form method="get" className="mt-4 flex flex-wrap items-end gap-2">
          <label className="text-sm text-gray-700">
            <span className="mr-2">{t.bdQtyLabel}</span>
            <input
              type="number"
              name="qty"
              min={1}
              step={1}
              defaultValue={qty}
              className="w-32 rounded-md border border-gray-300 px-2 py-1 text-sm tabular-nums"
            />
            <span className="ml-2 text-gray-500">{t.bdUnits}</span>
          </label>
          <button
            type="submit"
            className="rounded-md bg-echo-orange px-3 py-1.5 text-sm font-semibold text-white hover:opacity-90"
          >
            {t.bdQtyButton}
          </button>
        </form>
      </div>

      <div className="mt-6 overflow-x-auto rounded-lg border border-gray-200">
        <table className="min-w-full divide-y divide-gray-200 text-sm">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-3 py-2 text-left font-semibold text-gray-700">{t.colCode}</th>
              <th className="px-3 py-2 text-left font-semibold text-gray-700">{t.colItem}</th>
              <th className="px-3 py-2 text-right font-semibold text-gray-700">{t.bdColPerUnit}</th>
              <th className="px-3 py-2 text-right font-semibold text-gray-700">{t.bdColPerPallet}</th>
              <th className="px-3 py-2 text-right font-semibold text-gray-700">{t.colNeeded}</th>
              <th className="px-3 py-2 text-right font-semibold text-gray-700">{t.colQuantity}</th>
              <th className="px-3 py-2 text-right font-semibold text-gray-700">{t.colShortBy}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100 bg-white">
            {draw.map((r) => (
              <tr key={r.code} className={r.short > 0 ? 'bg-red-50/60' : undefined}>
                <td className="px-3 py-2 font-mono text-xs text-gray-600">{r.code}</td>
                <td className="px-3 py-2 text-gray-900">
                  {r.description}
                  {r.binding && (
                    <span className="ml-2 rounded-full bg-amber-50 px-2 py-0.5 text-xs font-semibold text-amber-900">
                      {t.bdBinding}
                    </span>
                  )}
                  {!r.gating && <p className="mt-0.5 text-xs text-gray-500">{t.bdNotGating}</p>}
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-gray-700">
                  {r.perUnit ? n(r.perUnit) : ''}
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-gray-700">
                  {r.perPallet ? n(r.perPallet) : ''}
                </td>
                <td className="px-3 py-2 text-right tabular-nums font-semibold text-gray-900">
                  {n(r.needed)}
                  {unitByCode.get(r.code) && (
                    <span className="ml-1 text-xs font-normal text-gray-500">{unitByCode.get(r.code)}</span>
                  )}
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-gray-700">
                  {r.have === null ? <span className="text-xs text-gray-400">{t.bdNotReported}</span> : n(r.have)}
                </td>
                <td className="px-3 py-2 text-right tabular-nums font-semibold text-red-700">
                  {r.short > 0 ? n(Math.ceil(r.short)) : ''}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
