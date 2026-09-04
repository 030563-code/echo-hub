'use client'

import { useRouter } from 'next/navigation'
import { useEffect, useRef, useState } from 'react'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { formatMoney, formatDate } from '@/lib/utils'
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
}

/**
 * Adds a contractor by searching HubSpot, so the id stored here is the same id
 * a deal carries. Typing a name by hand would give two records that never join.
 */
function ContractorEditor({ existing }: { existing?: ContractorRow }) {
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
        existing
          ? <Button size="sm" variant="outline">Edit</Button>
          : <Button size="sm">Add a contractor</Button>
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
}: {
  contractor: ContractorRow
  existing?: ContractPriceRecord
  skus: string[]
}) {
  const router = useRouter()
  const [sku, setSku] = useState(existing?.sku ?? '')
  const [currency, setCurrency] = useState(existing?.currency ?? 'USD')
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
        existing
          ? <Button size="sm" variant="outline">Edit</Button>
          : <Button size="sm" variant="outline">Add a price</Button>
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
  canEdit,
}: {
  contractors: ContractorRow[]
  prices: ContractPriceRecord[]
  skus: string[]
  canEdit: boolean
}) {
  const byCompany = new Map<string, ContractPriceRecord[]>()
  for (const price of prices) {
    const list = byCompany.get(price.hubspot_company_id) ?? []
    list.push(price)
    byCompany.set(price.hubspot_company_id, list)
  }

  return (
    <div className="space-y-4">
      {canEdit && (
        <div className="flex justify-end">
          <ContractorEditor />
        </div>
      )}

      {contractors.length === 0 ? (
        <Card className="bg-white border-gray-200">
          <p className="text-sm text-gray-600">
            No contractors yet. Add one by searching HubSpot, then give it the SKUs it has a
            negotiated price for.
          </p>
        </Card>
      ) : (
        contractors.map((contractor) => {
          const rows = byCompany.get(contractor.hubspot_company_id) ?? []
          return (
            <Card
              key={contractor.hubspot_company_id}
              className={`bg-white border-gray-200 p-0 overflow-hidden ${contractor.is_active === false ? 'opacity-60' : ''}`}
            >
              <div className="flex items-center justify-between border-b border-gray-100 px-4 py-3">
                <div>
                  <h2 className="font-semibold text-gray-900">
                    {contractor.name}
                    {contractor.is_active === false && (
                      <span className="ml-2 text-xs font-normal text-gray-500">(switched off)</span>
                    )}
                  </h2>
                  <p className="text-xs text-gray-500">{contractor.domain ?? 'no domain'}</p>
                </div>
                {canEdit && (
                  <div className="flex gap-2">
                    <ContractorEditor existing={contractor} />
                    <PriceEditor contractor={contractor} skus={skus} />
                  </div>
                )}
              </div>

              {rows.length === 0 ? (
                <p className="px-4 py-4 text-sm text-gray-500">No contract prices yet.</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-gray-200 text-left text-gray-600">
                        <th className="px-4 py-2.5 font-medium">SKU</th>
                        <th className="px-4 py-2.5 font-medium">Their code</th>
                        <th className="px-4 py-2.5 font-medium text-right">Price</th>
                        <th className="px-4 py-2.5 font-medium">In force</th>
                        <th className="px-4 py-2.5 font-medium">Last changed by</th>
                        {canEdit && <th className="px-4 py-2.5" />}
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((row) => (
                        <tr key={row.id} className={`border-b border-gray-100 last:border-0 ${row.is_active === false ? 'opacity-50' : ''}`}>
                          <td className="px-4 py-2.5 font-medium text-gray-900">{row.sku}</td>
                          <td className="px-4 py-2.5 text-gray-600">{row.customer_part_number ?? '—'}</td>
                          <td className="px-4 py-2.5 text-right tabular-nums text-gray-900">
                            {formatMoney(Number(row.unit_price), row.currency)}
                          </td>
                          <td className="px-4 py-2.5 text-gray-600">
                            {row.valid_from ? formatDate(row.valid_from) : 'always'}
                            {row.valid_to ? ` to ${formatDate(row.valid_to)}` : ''}
                          </td>
                          <td className="px-4 py-2.5 text-xs text-gray-500">{row.updated_by_label ?? '—'}</td>
                          {canEdit && (
                            <td className="px-4 py-2.5 text-right">
                              <PriceEditor contractor={contractor} existing={row} skus={skus} />
                            </td>
                          )}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>
          )
        })
      )}
    </div>
  )
}
