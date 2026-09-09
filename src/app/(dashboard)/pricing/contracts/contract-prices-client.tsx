'use client'

// page-state: none (dialog-scoped, committed on save; the dialog already keeps typed values on a save error)

import { useRouter } from 'next/navigation'
import { useEffect, useRef, useState } from 'react'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { formatMoney } from '@/lib/utils'
import { pickContractPrice } from '@/lib/pricing'
import { CURRENCY_NAME } from '@/lib/pipeline-config'
import { searchCompanies } from '@/app/actions/hubspot/searchCompanies'
import { saveContractPrice, saveContractor } from '@/app/actions/pricing/save-pricing'
import type { ContractPriceRecord, ContractorRow } from '@/app/actions/pricing/get-pricing'
import { EditRowDialog } from '../edit-row-dialog'

const CURRENCIES = Object.keys(CURRENCY_NAME)

function num(value: string): number | null {
  const trimmed = value.trim()
  if (trimmed === '') return null
  const n = Number(trimmed)
  return Number.isFinite(n) ? n : null
}

/** Contract windows are optional on both sides, and blank has to survive the
 *  round trip as null rather than becoming today. */
function orNull(value: string): string | null {
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

/** The flat shape searchCompanies returns. It merges HubSpot hits with the
 *  Hub's own account registry, so a result is not a raw HubSpot record. */
interface CompanyHit {
  id: string
  name: string
  domain?: string
  /** The search is portal-wide, and this portal keeps a company per owner for
   *  some accounts, so the owner is how the right one gets picked. */
  owner?: string
}

/**
 * Adds a contractor by searching HubSpot, so the id stored here is the same id
 * a deal carries. Typing a name by hand would give two records that never join.
 */
function ContractorEditor({
  existing,
  trigger,
}: {
  existing?: ContractorRow
  /** The company name in the grid's first column, when that is the trigger. */
  trigger?: React.ReactNode
}) {
  const router = useRouter()
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<CompanyHit[]>([])
  const [searching, setSearching] = useState(false)
  const [picked, setPicked] = useState<{ id: string; name: string; domain: string } | null>(
    existing ? { id: existing.hubspot_company_id, name: existing.name, domain: existing.domain ?? '' } : null,
  )
  const [isActive, setIsActive] = useState(existing?.is_active !== false)
  const [notes, setNotes] = useState(existing?.notes ?? '')
  // Guards against a slow early search landing after a later one, which would
  // show results for a query the admin has already moved on from.
  const seq = useRef(0)

  // Every setState lives inside the timer, never in the effect body: React's
  // compiler lint rejects a synchronous setState in an effect, and doing the
  // work in one place also means a keystroke cannot clear results a still
  // running search is about to replace.
  useEffect(() => {
    const timer = setTimeout(async () => {
      if (existing || query.trim().length < 2) {
        setHits([])
        setSearching(false)
        return
      }
      const mine = ++seq.current
      setSearching(true)
      const result = await searchCompanies(query.trim())
      // A stale response must not overwrite a newer one, nor clear its spinner.
      if (mine !== seq.current) return
      setHits(result.success ? ((result.data ?? []) as CompanyHit[]) : [])
      setSearching(false)
    }, 300)
    return () => clearTimeout(timer)
  }, [query, existing])

  return (
    <EditRowDialog
      title={existing ? existing.name : 'Add a contractor'}
      trigger={
        trigger ?? (existing
          ? <Button size="sm" variant="outline">Edit</Button>
          : <Button size="sm">Add a contractor</Button>)
      }
      onSave={async () => {
        if (!picked) return { success: false as const, error: 'Search for the company in HubSpot and pick it.' }
        return saveContractor({
          hubspot_company_id: picked.id,
          name: picked.name,
          domain: picked.domain || null,
          notes: notes || null,
          is_active: isActive,
        })
      }}
      onSaved={() => router.refresh()}
    >
      {!existing && (
        <div>
          <Label htmlFor="companySearch" className="text-gray-900">Find the company in HubSpot</Label>
          <Input
            id="companySearch"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="United Rentals, or ur.com"
            className="mt-1"
          />
          {searching && <p className="mt-1 text-xs text-gray-500">Searching...</p>}
          {hits.length > 0 && (
            <ul className="mt-2 max-h-40 overflow-y-auto rounded border border-gray-200">
              {hits.map((hit) => (
                <li key={hit.id}>
                  <button
                    type="button"
                    onClick={() => {
                      setPicked({ id: hit.id, name: hit.name || 'Unnamed', domain: hit.domain ?? '' })
                      setHits([])
                      setQuery('')
                    }}
                    className="block w-full px-3 py-2 text-left text-sm hover:bg-gray-50"
                  >
                    <span className="font-medium text-gray-900">{hit.name || 'Unnamed'}</span>
                    <span className="block text-xs text-gray-500">
                      {hit.domain ?? <span className="italic">no domain</span>}
                      {hit.owner && hit.owner !== '—' ? ` · ${hit.owner}` : ''}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {picked && (
        <div className="rounded border border-gray-200 bg-gray-50 px-3 py-2">
          <p className="text-sm font-medium text-gray-900">{picked.name}</p>
          <p className="text-xs text-gray-500">{picked.domain || 'no domain'} - HubSpot id {picked.id}</p>
        </div>
      )}

      <div>
        <Label htmlFor="notes" className="text-gray-900">Notes (optional)</Label>
        <Input id="notes" value={notes} onChange={(e) => setNotes(e.target.value)} className="mt-1" />
      </div>

      <label className="flex items-center gap-2 text-sm text-gray-700">
        <input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} />
        Apply this contractor prices to their deals
      </label>
    </EditRowDialog>
  )
}

function PriceEditor({
  contractor,
  existing,
  skus,
  productNames,
  presetSku,
  presetCurrency,
  trigger,
}: {
  contractor: ContractorRow
  existing?: ContractPriceRecord
  skus: string[]
  /** SKU to the product name as it reads in HubSpot. A SKU with no list price
   *  simply has no entry, and the row falls back to showing its SKU alone. */
  productNames: Record<string, string>
  /** Opening from a grid cell already knows which product and which currency
   *  the price is for, so the dialog does not ask again. */
  presetSku?: string
  presetCurrency?: string
  /** The cell itself, when the grid is the trigger rather than a button. */
  trigger?: React.ReactNode
}) {
  const router = useRouter()
  const [sku, setSku] = useState(existing?.sku ?? presetSku ?? '')
  const [currency, setCurrency] = useState(existing?.currency ?? presetCurrency ?? 'USD')
  const [unitPrice, setUnitPrice] = useState(existing ? String(existing.unit_price ?? '') : '')
  const [validFrom, setValidFrom] = useState(existing?.valid_from ?? '')
  const [validTo, setValidTo] = useState(existing?.valid_to ?? '')
  const [isActive, setIsActive] = useState(existing?.is_active !== false)
  // NOT part of the upsert key, unlike sku, currency and valid_from, so it
  // stays editable on an existing row.
  const [customerPart, setCustomerPart] = useState(existing?.customer_part_number ?? '')
  const locked = existing !== undefined

  return (
    <EditRowDialog
      title={existing ? `${existing.sku} for ${contractor.name}` : `Add a price for ${contractor.name}`}
      trigger={
        trigger ?? (existing
          ? <Button size="sm" variant="outline">Edit</Button>
          : <Button size="sm" variant="outline">Add a price</Button>)
      }
      onSave={async () => {
        if (!sku.trim()) return { success: false as const, error: 'Pick a SKU.' }
        const unit = num(unitPrice)
        if (unit === null) return { success: false as const, error: 'Type the contract price.' }
        return saveContractPrice({
          hubspot_company_id: contractor.hubspot_company_id,
          sku: sku.trim(),
          currency,
          unit_price: unit,
          valid_from: orNull(validFrom),
          valid_to: orNull(validTo),
          customer_part_number: orNull(customerPart),
          is_active: isActive,
        })
      }}
      onSaved={() => router.refresh()}
    >
      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label htmlFor="csku" className="text-gray-900">SKU</Label>
          {locked ? (
            <p className="mt-1 text-sm font-medium text-gray-900">{sku}</p>
          ) : (
            <Input id="csku" list="contract-skus" value={sku} onChange={(e) => setSku(e.target.value)} className="mt-1" placeholder="EBH9NA" />
          )}
          <datalist id="contract-skus">
            {skus.map((s) => <option key={s} value={s} />)}
          </datalist>
          {/* Names the product for the SKU as typed, so a wrong but plausible
              code (EBH9NA against EBH9XNA) is visible before it is saved. */}
          {productNames[sku.trim().toUpperCase()] && (
            <p className="mt-1 text-xs text-gray-600">{productNames[sku.trim().toUpperCase()]}</p>
          )}
        </div>
        <div>
          <Label htmlFor="ccur" className="text-gray-900">Currency</Label>
          {locked ? (
            <p className="mt-1 text-sm font-medium text-gray-900">{currency}</p>
          ) : (
            <select
              id="ccur"
              value={currency}
              onChange={(e) => setCurrency(e.target.value)}
              className="mt-1 w-full rounded border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900"
            >
              {CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          )}
        </div>
      </div>
      <div>
        <Label htmlFor="cprice" className="text-gray-900">Contract price</Label>
        <Input id="cprice" inputMode="decimal" value={unitPrice} onChange={(e) => setUnitPrice(e.target.value)} className="mt-1" />
      </div>
      <div>
        <Label htmlFor="cpart" className="text-gray-900">Their part number (optional)</Label>
        <Input
          id="cpart"
          value={customerPart}
          onChange={(e) => setCustomerPart(e.target.value)}
          className="mt-1"
          placeholder="H9G"
        />
        {/* Every contractor names the same product differently. Herc's H9 is
            "H9G", United Rentals' is "ECHOBARRIER H9 GREEN". Holding their code
            is what lets a rep tie the line to the customer's own order. */}
        <p className="mt-1 text-xs text-gray-500">
          The code this customer uses on their purchase orders, so a rep can match the line to it.
        </p>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label htmlFor="from" className="text-gray-900">In force from</Label>
          <Input id="from" type="date" value={validFrom} onChange={(e) => setValidFrom(e.target.value)} className="mt-1" disabled={locked} />
        </div>
        <div>
          <Label htmlFor="to" className="text-gray-900">Until</Label>
          <Input id="to" type="date" value={validTo} onChange={(e) => setValidTo(e.target.value)} className="mt-1" />
        </div>
      </div>
      <p className="text-xs text-gray-500">
        Leave the dates blank for a price with no end. To renegotiate, add a second price with a later
        start date; the quote builder always takes the most recent one in force.
      </p>
      <label className="flex items-center gap-2 text-sm text-gray-700">
        <input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} />
        Apply this price
      </label>
    </EditRowDialog>
  )
}

export function ContractPricesClient({
  contractors,
  prices,
  skus,
  productNames,
  canEdit,
  today,
}: {
  contractors: ContractorRow[]
  prices: ContractPriceRecord[]
  skus: string[]
  /** SKU to the product name as it reads in HubSpot, resolved from the list
   *  prices the page already loads. */
  productNames: Record<string, string>
  canEdit: boolean
  /** yyyy-mm-dd from the server, so the grid and the quote builder agree on
   *  what is in force and the markup does not change under hydration. */
  today: string
}) {
  // Contractors price in more than one currency (Herc and United Rentals hold
  // both USD and CAD on the same products), and a cell can only hold one
  // number. One currency at a time, which is also how a quote works.
  // USD first because it is the default and every contractor has one.
  const currencies = Array.from(new Set(prices.map((p) => p.currency))).sort((a, b) =>
    a === 'USD' ? -1 : b === 'USD' ? 1 : a.localeCompare(b),
  )
  const [currency, setCurrency] = useState(currencies.includes('USD') ? 'USD' : (currencies[0] ?? 'USD'))

  const forCurrency = prices.filter((p) => p.currency === currency)

  // company id -> sku -> the rows behind that cell
  const cells = new Map<string, Map<string, ContractPriceRecord[]>>()
  for (const price of forCurrency) {
    const byCompany = cells.get(price.hubspot_company_id) ?? new Map<string, ContractPriceRecord[]>()
    byCompany.set(price.sku, [...(byCompany.get(price.sku) ?? []), price])
    cells.set(price.hubspot_company_id, byCompany)
  }

  // Only products somebody actually has a contract price for, so the grid stays
  // as wide as the negotiated range rather than as wide as the whole catalogue.
  const columns = Array.from(new Set(forCurrency.map((p) => p.sku))).sort((a, b) =>
    (productNames[a] ?? a).localeCompare(productNames[b] ?? b),
  )

  const label = (sku: string) => productNames[sku] ?? sku
  /** Every product is an Echo Barrier one, so the brand in twelve column
   *  headings is six lines of wrapping that say nothing. The full name stays
   *  on the heading's title. */
  const shortLabel = (sku: string) => label(sku).replace(/^Echo\s*Barrier\s*/i, '').trim() || label(sku)

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        {currencies.length > 1 ? (
          <div className="inline-flex rounded-md border border-gray-200 bg-white p-0.5">
            {currencies.map((code) => (
              <button
                key={code}
                type="button"
                onClick={() => setCurrency(code)}
                className={
                  code === currency
                    ? 'rounded px-3 py-1.5 text-sm font-semibold bg-gray-900 text-white'
                    : 'rounded px-3 py-1.5 text-sm font-medium text-gray-600 hover:text-gray-900'
                }
              >
                {code}
              </button>
            ))}
          </div>
        ) : (
          <span />
        )}
        {canEdit && <ContractorEditor />}
      </div>

      {contractors.length === 0 ? (
        <Card className="bg-white border-gray-200">
          <p className="text-sm text-gray-600">
            No contractors yet. Add one by searching HubSpot, then give it the SKUs it has a
            negotiated price for.
          </p>
        </Card>
      ) : columns.length === 0 ? (
        <Card className="bg-white border-gray-200">
          <p className="text-sm text-gray-600">No contract prices in {currency} yet.</p>
        </Card>
      ) : (
        <Card className="bg-white border-gray-200 p-0 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm border-separate border-spacing-0">
              <thead>
                <tr className="text-left text-gray-600">
                  {/* Sticky, so the company is still readable once the grid is
                      scrolled sideways past a dozen products. */}
                  <th className="sticky left-0 z-10 bg-white border-b border-gray-200 px-4 py-2.5 font-medium">
                    Contractor
                  </th>
                  {columns.map((sku) => (
                    <th
                      key={sku}
                      title={label(sku)}
                      className="w-28 min-w-28 border-b border-gray-200 px-3 py-2.5 text-right font-medium align-bottom"
                    >
                      <span className="block text-gray-900 leading-tight">{shortLabel(sku)}</span>
                      <span className="block text-xs font-normal text-gray-500">{sku}</span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {contractors.map((contractor) => {
                  const row = cells.get(contractor.hubspot_company_id)
                  const off = contractor.is_active === false
                  return (
                    <tr key={contractor.hubspot_company_id} className={off ? 'opacity-60' : ''}>
                      <th
                        scope="row"
                        className="sticky left-0 z-10 bg-white border-b border-gray-100 px-4 py-2.5 text-left font-medium text-gray-900 whitespace-nowrap"
                      >
                        {canEdit ? (
                          <ContractorEditor
                            existing={contractor}
                            trigger={
                              <button type="button" className="text-left hover:underline">
                                {contractor.name}
                              </button>
                            }
                          />
                        ) : (
                          contractor.name
                        )}
                        {off && <span className="ml-2 text-xs font-normal text-gray-500">(switched off)</span>}
                      </th>
                      {columns.map((sku) => {
                        const found = row?.get(sku) ?? []
                        // The same function the quote builder resolves with, so
                        // a cell is never a price nobody is charged.
                        const live = pickContractPrice(found, {
                          sku,
                          currency,
                          companyId: contractor.hubspot_company_id,
                          today,
                        })
                        // A price that exists but is not in force today is shown
                        // greyed rather than hidden: an empty cell would read as
                        // "no deal on this product", which is a different thing.
                        const shown = live ?? found[0] ?? null
                        const content = shown === null
                          ? <span className="text-gray-300">&mdash;</span>
                          : (
                            <span
                              className={live ? 'tabular-nums text-gray-900' : 'tabular-nums text-gray-400 italic'}
                              title={live ? undefined : 'Not in force today'}
                            >
                              {formatMoney(Number(shown.unit_price), shown.currency)}
                            </span>
                          )
                        return (
                          <td key={sku} className="border-b border-gray-100 px-3 py-2.5 text-right">
                            {canEdit ? (
                              <PriceEditor
                                contractor={contractor}
                                existing={shown ?? undefined}
                                presetSku={sku}
                                presetCurrency={currency}
                                skus={skus}
                                productNames={productNames}
                                trigger={
                                  <button
                                    type="button"
                                    className="w-full rounded px-2 py-1 text-right hover:bg-gray-100"
                                    title={shown ? 'Change this price' : `Set a ${currency} price for ${label(sku)}`}
                                  >
                                    {content}
                                  </button>
                                }
                              />
                            ) : (
                              content
                            )}
                          </td>
                        )
                      })}
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      <p className="text-xs text-gray-500">
        Each cell is the price a quote would use today. Click one to change it, or an empty one to add
        a price. Click a contractor to edit the company.
      </p>
    </div>
  )
}
