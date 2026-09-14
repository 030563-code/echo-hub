'use client'

// page-state: view commercial-invoices:hs-codes (the search box). The code
// inputs on each row are deliberately not kept: every row is committed on its
// own with its Save button, so there is never a half-typed draft to restore.

import { useMemo, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Loader2, Save } from 'lucide-react'
import { toast } from 'sonner'
import { Card } from '@/components/ui/card'
import { SearchBox } from '@/components/ui/search-box'
import { usePersistedView } from '@/hooks/use-page-state'
import { parseSearchView, type SearchView } from '@/lib/page-drafts'
import { INVOICE_LEGS, LEG_CONFIG, type InvoiceLeg } from '@/lib/invoice-legs'
import { isValidHsCode, normaliseHsCode } from '@/lib/hs-codes'
import { saveHsCodes } from '@/app/actions/invoices/save-hs-codes'
import { cn } from '@/lib/utils'

export interface HsCodeProduct {
  sku: string
  product_name: string | null
  codes: Record<InvoiceLeg, string>
}

export default function HsCodesClient({
  products,
  canEdit,
  loadError,
}: {
  products: HsCodeProduct[]
  canEdit: boolean
  loadError: string | null
}) {
  const [view, setView] = usePersistedView<SearchView>('commercial-invoices:hs-codes', { v: 1, q: '' }, parseSearchView)
  const q = view.q
  const setQ = (next: string) => setView({ v: 1, q: next })

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase()
    if (!needle) return products
    return products.filter((p) => `${p.sku} ${p.product_name ?? ''}`.toLowerCase().includes(needle))
  }, [products, q])

  const missing = INVOICE_LEGS.map((leg) => ({
    leg,
    count: products.filter((p) => normaliseHsCode(p.codes[leg]) === '').length,
  }))
  const allSet = products.length > 0 && missing.every((m) => m.count === 0)

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold text-gray-900" style={{ fontFamily: 'Varela Round, sans-serif' }}>
            HS codes
          </h1>
          <p className="mt-1 max-w-3xl text-sm text-gray-500">
            The code printed on each commercial invoice line, for each leg. An invoice with a blank code cannot be issued. Type the
            code as it should print, for example 3926.90 or 3926 90 97. Clearing a box removes that code.
          </p>
        </div>
        {products.length > 0 && (
          <SearchBox value={q} onChange={setQ} placeholder="Search product or SKU…" className="w-full sm:w-64 shrink-0" />
        )}
      </div>

      {loadError ? (
        <p className="text-sm text-red-700">{loadError}</p>
      ) : products.length === 0 ? (
        <p className="text-sm text-gray-500">No product has an intercompany price yet, so there is nothing to code.</p>
      ) : (
        <>
          <p className="mb-1 text-sm text-gray-700" data-testid="hs-codes-summary">
            {allSet
              ? 'Every product has a code on every leg.'
              : `Still missing a code: ${missing.map((m) => `${LEG_CONFIG[m.leg].label} ${m.count} of ${products.length}`).join(', ')}.`}
          </p>
          <p className="mb-4 text-xs text-gray-500">
            Codes reach invoices generated after you save. For a draft that already exists, open it with Edit and fill its blank
            codes from here.
            {!canEdit && ' You can see these codes but not change them.'}
          </p>

          <Card className="bg-white border-gray-200 p-0 overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[720px] text-sm">
                <thead>
                  <tr className="bg-gray-50 text-[10px] uppercase tracking-wider text-gray-500">
                    <th className="px-4 py-2.5 text-left font-medium">Product</th>
                    {INVOICE_LEGS.map((leg) => (
                      <th key={leg} className="px-3 py-2.5 text-left font-medium">
                        {LEG_CONFIG[leg].label}
                      </th>
                    ))}
                    {canEdit && <th className="px-4 py-2.5" />}
                  </tr>
                </thead>
                <tbody>
                  {filtered.length === 0 && (
                    <tr>
                      <td colSpan={INVOICE_LEGS.length + (canEdit ? 2 : 1)} className="px-4 py-8 text-center text-sm text-gray-500">
                        No products match “{q}”.
                      </td>
                    </tr>
                  )}
                  {filtered.map((p) => (
                    // Keyed on the saved codes too, so a save that the server
                    // normalised remounts the row with what was really stored.
                    <HsCodeRow key={`${p.sku}:${INVOICE_LEGS.map((leg) => p.codes[leg]).join('|')}`} product={p} canEdit={canEdit} />
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </>
      )}
    </div>
  )
}

function HsCodeRow({ product, canEdit }: { product: HsCodeProduct; canEdit: boolean }) {
  const router = useRouter()
  const [codes, setCodes] = useState<Record<InvoiceLeg, string>>(product.codes)
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  const state = INVOICE_LEGS.map((leg) => {
    const code = normaliseHsCode(codes[leg])
    return { leg, code, invalid: code !== '' && !isValidHsCode(code), changed: code !== normaliseHsCode(product.codes[leg]) }
  })
  const invalid = state.filter((s) => s.invalid)
  const changed = state.some((s) => s.changed)
  const label = product.product_name && product.product_name !== product.sku ? product.product_name : product.sku

  function save() {
    if (invalid.length) return
    setError(null)
    startTransition(async () => {
      const res = await saveHsCodes({ sku: product.sku, codes })
      if (!res.ok) {
        setError(res.error)
        toast.error(res.error)
        return
      }
      toast.success(`HS codes saved for ${label}`)
      router.refresh()
    })
  }

  return (
    <tr className="border-t border-gray-100 align-top" data-sku={product.sku}>
      <td className="px-4 py-2.5">
        <span className="block text-gray-900">{label}</span>
        <span className="block font-mono text-[11px] text-gray-500">{product.sku}</span>
        {error && <span className="mt-1 block text-xs text-red-700">{error}</span>}
        {invalid.length > 0 && (
          <span className="mt-1 block text-xs text-red-700" role="alert">
            {invalid.map((s) => LEG_CONFIG[s.leg].label).join(', ')}: an HS code is 6 to 10 digits, split by single dots or spaces.
          </span>
        )}
      </td>
      {state.map((s) => (
        <td key={s.leg} className="px-3 py-2.5">
          {canEdit ? (
            <input
              value={codes[s.leg]}
              onChange={(e) => setCodes((cur) => ({ ...cur, [s.leg]: e.target.value }))}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && changed && !invalid.length && !pending) save()
              }}
              placeholder="Not set"
              aria-label={`${LEG_CONFIG[s.leg].label} HS code for ${label}`}
              aria-invalid={s.invalid || undefined}
              maxLength={40}
              className={cn(
                'w-full min-w-[8rem] rounded border border-gray-300 bg-white px-2 py-1.5 font-mono text-xs text-gray-900 focus:border-echo-orange focus:outline-none',
                s.invalid && 'border-red-500 focus:border-red-600',
                !s.invalid && s.code === '' && 'border-amber-300',
              )}
            />
          ) : s.code ? (
            <span className="font-mono text-xs text-gray-900">{s.code}</span>
          ) : (
            <span className="text-xs text-amber-700">Not set</span>
          )}
        </td>
      ))}
      {canEdit && (
        <td className="px-4 py-2.5 text-right">
          <button
            type="button"
            onClick={save}
            disabled={!changed || invalid.length > 0 || pending}
            className="inline-flex items-center gap-1.5 rounded-lg border border-gray-300 px-3 py-1.5 text-xs text-gray-700 transition-colors hover:border-gray-400 hover:bg-gray-50 hover:text-gray-900 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
            Save
          </button>
        </td>
      )}
    </tr>
  )
}
