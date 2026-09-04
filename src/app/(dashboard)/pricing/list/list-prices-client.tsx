'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { formatMoney } from '@/lib/utils'
import { CURRENCY_NAME } from '@/lib/pipeline-config'
import { saveListPrice } from '@/app/actions/pricing/save-pricing'
import type { ListPriceRecord } from '@/app/actions/pricing/get-pricing'
import { EditRowDialog } from '../edit-row-dialog'

export interface CatalogueEntry {
  sku: string
  name: string
  hsProductId: string
  hubspotPrice: string
}

interface Draft {
  sku: string
  currency: string
  productName: string
  hsProductId: string
  unitPrice: string
  mapPrice: string
  floorPrice: string
  isActive: boolean
}

const CURRENCIES = Object.keys(CURRENCY_NAME)
const EMPTY: Draft = { sku: '', currency: 'USD', productName: '', hsProductId: '', unitPrice: '', mapPrice: '', floorPrice: '', isActive: true }

/** Blank means "not set", which is different from zero: a floor of 0 is a real
 *  floor that forbids giving the item away. */
function num(value: string): number | null {
  const trimmed = value.trim()
  if (trimmed === '') return null
  const n = Number(trimmed)
  return Number.isFinite(n) ? n : null
}

function PriceFields({
  state,
  set,
  lockKey,
  catalogue,
}: {
  state: Draft
  set: (patch: Partial<Draft>) => void
  lockKey: boolean
  catalogue: CatalogueEntry[]
}) {
  return (
    <>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label htmlFor="sku" className="text-gray-900">SKU</Label>
          {lockKey ? (
            <p className="mt-1 text-sm font-medium text-gray-900">{state.sku}</p>
          ) : (
            <select
              id="sku"
              value={state.sku}
              onChange={(e) => {
                const entry = catalogue.find((c) => c.sku === e.target.value)
                set({ sku: e.target.value, productName: entry?.name ?? '', hsProductId: entry?.hsProductId ?? '' })
              }}
              className="mt-1 w-full rounded border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900"
            >
              <option value="">Pick a product</option>
              {catalogue.map((c) => (
                <option key={c.sku} value={c.sku}>{c.sku} ({c.name})</option>
              ))}
            </select>
          )}
        </div>
        <div>
          <Label htmlFor="currency" className="text-gray-900">Currency</Label>
          {lockKey ? (
            <p className="mt-1 text-sm font-medium text-gray-900">{state.currency}</p>
          ) : (
            <select
              id="currency"
              value={state.currency}
              onChange={(e) => set({ currency: e.target.value })}
              className="mt-1 w-full rounded border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900"
            >
              {CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          )}
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label htmlFor="unitPrice" className="text-gray-900">List price</Label>
          <Input id="unitPrice" inputMode="decimal" value={state.unitPrice} onChange={(e) => set({ unitPrice: e.target.value })} className="mt-1" />
        </div>
        <div>
          <Label htmlFor="floorPrice" className="text-gray-900">Distributor net, the floor (optional)</Label>
          <Input id="floorPrice" inputMode="decimal" value={state.floorPrice} onChange={(e) => set({ floorPrice: e.target.value })} className="mt-1" />
          <p className="mt-1 text-xs text-gray-500">The lowest a discount may reach. Blank means no floor.</p>
        </div>
      </div>
      <div>
        <Label htmlFor="mapPrice" className="text-gray-900">MAP, advertised (optional)</Label>
        <Input id="mapPrice" inputMode="decimal" value={state.mapPrice} onChange={(e) => set({ mapPrice: e.target.value })} className="mt-1" />
        {/* Reference only. The quote builder never reaches for it, so it is
            deliberately not offered as a starting price anywhere. */}
        <p className="mt-1 text-xs text-gray-500">
          The advertised price from the sheet. Held for reference; the quote builder never applies it.
        </p>
      </div>
      <label className="flex items-center gap-2 text-sm text-gray-700">
        <input type="checkbox" checked={state.isActive} onChange={(e) => set({ isActive: e.target.checked })} />
        Use this price in the quote builder
      </label>
    </>
  )
}

/**
 * One dialog, one row, one piece of state.
 *
 * Each editor owns its draft rather than sharing one at the table level. A
 * shared draft only syncs when a field changes, so opening a row and saving it
 * untouched would write whatever the last row left behind, which on this table
 * means the wrong SKU at the wrong price.
 */
function PriceEditor({
  initial,
  lockKey,
  catalogue,
  title,
  trigger,
}: {
  initial: Draft
  lockKey: boolean
  catalogue: CatalogueEntry[]
  title: string
  trigger: React.ReactNode
}) {
  const router = useRouter()
  const [state, setState] = useState<Draft>(initial)

  return (
    <EditRowDialog
      title={title}
      trigger={trigger}
      onSave={async () => {
        if (!state.sku) return { success: false as const, error: 'Pick a product.' }
        const unit = num(state.unitPrice)
        if (unit === null) return { success: false as const, error: 'Type a list price.' }
        return saveListPrice({
          sku: state.sku,
          currency: state.currency,
          product_name: state.productName || null,
          hs_product_id: state.hsProductId || null,
          unit_price: unit,
          map_price: num(state.mapPrice),
          floor_price: num(state.floorPrice),
          is_active: state.isActive,
        })
      }}
      onSaved={() => {
        if (!lockKey) setState(EMPTY)
        router.refresh()
      }}
    >
      <PriceFields state={state} set={(patch) => setState({ ...state, ...patch })} lockKey={lockKey} catalogue={catalogue} />
    </EditRowDialog>
  )
}

export function ListPricesClient({
  prices,
  catalogue,
  canEdit,
}: {
  prices: ListPriceRecord[]
  catalogue: CatalogueEntry[]
  canEdit: boolean
}) {
  const catalogueBySku = new Map(catalogue.map((c) => [c.sku, c]))

  return (
    <Card className="bg-white border-gray-200 p-0 overflow-hidden">
      {canEdit && (
        <div className="flex justify-end border-b border-gray-100 px-4 py-3">
          <PriceEditor
            initial={EMPTY}
            lockKey={false}
            catalogue={catalogue}
            title="Add a list price"
            trigger={<Button size="sm">Add a price</Button>}
          />
        </div>
      )}

      {prices.length === 0 ? (
        <p className="px-4 py-8 text-center text-sm text-gray-500">
          No list prices yet. Until one exists for a SKU the quote builder falls back to the HubSpot
          catalogue price, which is a placeholder, and asks the rep to type the real figure.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-200 text-left text-gray-600">
                <th className="px-4 py-3 font-medium">SKU</th>
                <th className="px-4 py-3 font-medium">Product</th>
                <th className="px-4 py-3 font-medium text-right">Quoted price (MAP)</th>
                <th className="px-4 py-3 font-medium text-right">MAP</th>
                <th className="px-4 py-3 font-medium text-right">Distributor net</th>
                <th className="px-4 py-3 font-medium text-right">In HubSpot</th>
                <th className="px-4 py-3 font-medium">Last changed by</th>
                {canEdit && <th className="px-4 py-3" />}
              </tr>
            </thead>
            <tbody>
              {prices.map((p) => {
                const entry = catalogueBySku.get(p.sku)
                return (
                  <tr key={p.id} className={`border-b border-gray-100 last:border-0 ${p.is_active === false ? 'opacity-50' : ''}`}>
                    <td className="px-4 py-2.5 font-medium text-gray-900">
                      {p.sku}
                      {p.is_active === false && <span className="ml-2 text-xs text-gray-500">(off)</span>}
                    </td>
                    <td className="px-4 py-2.5 text-gray-600">{p.product_name ?? entry?.name ?? '—'}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-gray-900">
                      {formatMoney(Number(p.unit_price), p.currency)}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums text-gray-600">
                      {p.map_price == null ? '—' : formatMoney(Number(p.map_price), p.currency)}
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-gray-600">
                      {p.floor_price == null ? '—' : formatMoney(Number(p.floor_price), p.currency)}
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-gray-400">
                      {entry ? formatMoney(Number(entry.hubspotPrice), p.currency) : '—'}
                    </td>
                    <td className="px-4 py-2.5 text-xs text-gray-500">{p.updated_by_label ?? '—'}</td>
                    {canEdit && (
                      <td className="px-4 py-2.5 text-right">
                        <PriceEditor
                          initial={{
                            sku: p.sku,
                            currency: p.currency,
                            productName: p.product_name ?? '',
                            hsProductId: p.hs_product_id ?? '',
                            unitPrice: String(p.unit_price ?? ''),
                            mapPrice: p.map_price == null ? '' : String(p.map_price),
                            floorPrice: p.floor_price == null ? '' : String(p.floor_price),
                            isActive: p.is_active !== false,
                          }}
                          lockKey
                          catalogue={catalogue}
                          title={`${p.sku} (${p.currency})`}
                          trigger={<Button size="sm" variant="outline">Edit</Button>}
                        />
                      </td>
                    )}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  )
}
