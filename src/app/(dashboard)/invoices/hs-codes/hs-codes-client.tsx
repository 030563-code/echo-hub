'use client'

// page-state: draft invoices:hs-codes (the codes typed but not saved yet, by SKU
// and leg) and view commercial-invoices:hs-codes (the search box). The typed
// codes live here in the table, not in each row, so filtering or leaving the
// page never throws them away. Every row still commits only with its own Save
// button; the draft is deleted once no row has unsaved changes.

import { useEffect, useMemo, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Loader2, Save } from 'lucide-react'
import { toast } from 'sonner'
import { Card } from '@/components/ui/card'
import { SearchBox } from '@/components/ui/search-box'
import { DraftStrip } from '@/components/page-state/draft-strip'
import { usePageState, usePersistedView } from '@/hooks/use-page-state'
import {
  HS_CODES_DRAFT_KEY,
  parseHsCodesDraft,
  parseSearchView,
  type HsCodesDraft,
  type SearchView,
} from '@/lib/page-drafts'
import { INVOICE_LEGS, LEG_CONFIG, type InvoiceLeg } from '@/lib/invoice-legs'
import { isValidHsCode, normaliseHsCode } from '@/lib/hs-codes'
import { saveHsCodes } from '@/app/actions/invoices/save-hs-codes'
import { cn } from '@/lib/utils'

export interface HsCodeProduct {
  sku: string
  product_name: string | null
  codes: Record<InvoiceLeg, string>
  /** The legs this product has an active intercompany price on. Only these count a missing code. */
  pricedLegs: InvoiceLeg[]
}

type LegCodes = Partial<Record<InvoiceLeg, string>>

/** Codes typed on the screen, by SKU then leg, exactly as typed. */
type Typed = Record<string, LegCodes>

/**
 * Codes this screen saved, remembered until the refreshed page data carries
 * them. `over` is the code the page data held when the save went out: while the
 * page data still shows that, the saved value is the truth; once it shows
 * anything else, the page data has caught up (or moved on) and wins.
 */
type SavedHere = Record<string, Partial<Record<InvoiceLeg, { value: string; over: string }>>>

const HS_CODE_MESSAGE = 'an HS code is 6 to 10 digits, split by single dots or spaces, for example 3926.90 or 3926 90 97.'

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

  const [typed, setTyped] = useState<Typed>({})
  const [savedHere, setSavedHere] = useState<SavedHere>({})
  /** `${sku}:${leg}` for each box whose format error is on show (after a blur, Enter or Save). */
  const [revealed, setRevealed] = useState<Record<string, true>>({})

  // The saved code for a product on a leg, as far as this screen knows.
  const baseline = (p: HsCodeProduct, leg: InvoiceLeg): string => {
    const mine = savedHere[p.sku]?.[leg]
    return mine && mine.over === p.codes[leg] ? mine.value : p.codes[leg]
  }
  const baselineCodes = (p: HsCodeProduct) =>
    Object.fromEntries(INVOICE_LEGS.map((leg) => [leg, baseline(p, leg)])) as Record<InvoiceLeg, string>
  const valueCodes = (p: HsCodeProduct) =>
    Object.fromEntries(INVOICE_LEGS.map((leg) => [leg, typed[p.sku]?.[leg] ?? baseline(p, leg)])) as Record<InvoiceLeg, string>

  // Only the legs whose typed code differs from the saved one, as typed: this is
  // what the draft keeps and what marks a row unsaved.
  const unsaved = useMemo(() => {
    const out: Typed = {}
    for (const p of products) {
      const row = typed[p.sku]
      if (!row) continue
      const changed: LegCodes = {}
      for (const leg of INVOICE_LEGS) {
        const value = row[leg]
        if (value === undefined) continue
        const mine = savedHere[p.sku]?.[leg]
        const saved = mine && mine.over === p.codes[leg] ? mine.value : p.codes[leg]
        if (normaliseHsCode(value) !== normaliseHsCode(saved)) changed[leg] = value
      }
      if (Object.keys(changed).length) out[p.sku] = changed
    }
    return out
  }, [products, typed, savedHere])
  const unsavedCount = Object.keys(unsaved).length

  const {
    restored: restoredDraft,
    save: saveDraft,
    clear: clearDraft,
    saveStatus: draftSaveStatus,
    savedAt: draftSavedAt,
  } = usePageState<HsCodesDraft>({
    pageKey: HS_CODES_DRAFT_KEY,
    parse: parseHsCodesDraft,
    enabled: canEdit,
    load: canEdit,
    onRestore: (restored) => {
      if (!restored) return
      // Anything typed while the read was in flight wins over the stored copy.
      setTyped((cur) => {
        const next: Typed = { ...restored.data.codes }
        for (const [sku, legs] of Object.entries(cur)) next[sku] = { ...next[sku], ...legs }
        return next
      })
    },
    isEmpty: (d) => Object.keys(d.codes).length === 0,
  })

  useEffect(() => {
    if (!canEdit) return
    saveDraft({ v: 1, codes: unsaved })
  }, [canEdit, saveDraft, unsaved])

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase()
    if (!needle) return products
    return products.filter((p) => `${p.sku} ${p.product_name ?? ''}`.toLowerCase().includes(needle))
  }, [products, q])

  // A missing code counts only on a leg the product is priced on.
  const missing = INVOICE_LEGS.map((leg) => {
    const priced = products.filter((p) => p.pricedLegs.includes(leg))
    return { leg, priced: priced.length, count: priced.filter((p) => normaliseHsCode(baseline(p, leg)) === '').length }
  })
  const allSet = products.length > 0 && missing.every((m) => m.count === 0)
  const unpricedCount = products.filter((p) => p.pricedLegs.length === 0).length

  function setCode(sku: string, leg: InvoiceLeg, value: string) {
    setTyped((cur) => ({ ...cur, [sku]: { ...cur[sku], [leg]: value } }))
    // Typing hides the format error until the next blur, Enter or Save.
    setRevealed((cur) => {
      if (!cur[`${sku}:${leg}`]) return cur
      const next = { ...cur }
      delete next[`${sku}:${leg}`]
      return next
    })
  }

  function reveal(sku: string, legs: InvoiceLeg[]) {
    if (!legs.length) return
    setRevealed((cur) => {
      const next = { ...cur }
      for (const leg of legs) next[`${sku}:${leg}`] = true
      return next
    })
  }

  function onSaved(p: HsCodeProduct, codes: LegCodes) {
    const legs = INVOICE_LEGS.filter((leg) => codes[leg] !== undefined)
    setSavedHere((cur) => {
      const row = { ...cur[p.sku] }
      for (const leg of legs) row[leg] = { value: codes[leg] as string, over: p.codes[leg] }
      return { ...cur, [p.sku]: row }
    })
    setTyped((cur) => {
      const row = { ...cur[p.sku] }
      // Only what went out: a box retyped while the save was in flight keeps its newer value.
      for (const leg of legs) {
        if (row[leg] !== undefined && normaliseHsCode(row[leg]) === codes[leg]) delete row[leg]
      }
      const next = { ...cur }
      if (Object.keys(row).length) next[p.sku] = row
      else delete next[p.sku]
      return next
    })
    const othersUnsaved = Object.keys(unsaved).some((sku) => sku !== p.sku)
    const thisRowLeft = Object.keys(unsaved[p.sku] ?? {}).some((leg) => !legs.includes(leg as InvoiceLeg))
    if (!othersUnsaved && !thisRowLeft) void clearDraft()
  }

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

      {canEdit && restoredDraft && unsavedCount > 0 && (
        <div className="mb-4">
          <DraftStrip
            what="the HS codes you had typed but not saved"
            savedAt={draftSavedAt}
            onStartAgain={async () => {
              await clearDraft()
              setTyped({})
              setRevealed({})
            }}
            startAgainLabel="Discard them"
            saveStatus={draftSaveStatus}
          />
        </div>
      )}

      {loadError ? (
        <p className="text-sm text-red-700">{loadError}</p>
      ) : products.length === 0 ? (
        <p className="text-sm text-gray-500">
          No product has an intercompany price or an entry in the product catalogue yet, so there is nothing to code.
        </p>
      ) : (
        <>
          <p className="mb-1 text-sm text-gray-700">
            <span data-testid="hs-codes-summary">
              {allSet
                ? 'Every product has a code on every leg it is sold on.'
                : `Still missing a code: ${missing
                    .filter((m) => m.priced > 0)
                    .map((m) => `${LEG_CONFIG[m.leg].label} ${m.count} of ${m.priced}`)
                    .join(', ')}.`}
            </span>
            {unsavedCount > 0 && (
              <span className="ml-2 font-medium text-amber-800" data-testid="hs-codes-unsaved">
                {unsavedCount === 1 ? '1 row has unsaved changes.' : `${unsavedCount} rows have unsaved changes.`}
              </span>
            )}
          </p>
          <p className="mb-4 max-w-3xl text-xs text-gray-500">
            A leg only counts for a product with a transfer price on it; the other boxes say &ldquo;Not sold on this leg&rdquo; and can
            still take a code.
            {unpricedCount > 0 &&
              ` ${unpricedCount === 1 ? '1 catalogue product has' : `${unpricedCount} catalogue products have`} no transfer price yet, so ${unpricedCount === 1 ? 'it is' : 'they are'} not counted, but an invoice line for one still needs a code.`}{' '}
            Codes reach invoices generated after you save. For a draft that already exists, open it with Edit and use Fill, or void
            and regenerate it. Split parts from a composition rule (for example the CS Enclosure frame and body) share one SKU, so
            this tab cannot fill them: type their codes on the draft with Edit.
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
                    <HsCodeRow
                      key={p.sku}
                      product={p}
                      values={valueCodes(p)}
                      saved={baselineCodes(p)}
                      revealedLegs={INVOICE_LEGS.filter((leg) => revealed[`${p.sku}:${leg}`])}
                      canEdit={canEdit}
                      onChange={(leg, value) => setCode(p.sku, leg, value)}
                      onReveal={(legs) => reveal(p.sku, legs)}
                      onSaved={(codes) => onSaved(p, codes)}
                    />
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

function HsCodeRow({
  product,
  values,
  saved,
  revealedLegs,
  canEdit,
  onChange,
  onReveal,
  onSaved,
}: {
  product: HsCodeProduct
  values: Record<InvoiceLeg, string>
  saved: Record<InvoiceLeg, string>
  revealedLegs: InvoiceLeg[]
  canEdit: boolean
  onChange: (leg: InvoiceLeg, value: string) => void
  onReveal: (legs: InvoiceLeg[]) => void
  onSaved: (codes: LegCodes) => void
}) {
  const router = useRouter()
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  const state = INVOICE_LEGS.map((leg) => {
    const code = normaliseHsCode(values[leg])
    const invalid = code !== '' && !isValidHsCode(code)
    return {
      leg,
      code,
      invalid,
      shown: invalid && revealedLegs.includes(leg),
      changed: code !== normaliseHsCode(saved[leg]),
      counted: product.pricedLegs.includes(leg),
    }
  })
  const invalid = state.filter((s) => s.invalid)
  const shown = state.filter((s) => s.shown)
  const changed = state.filter((s) => s.changed)
  const label = product.product_name && product.product_name !== product.sku ? product.product_name : product.sku
  const errorId = `hs-code-error-${product.sku}`

  function save() {
    if (invalid.length) {
      onReveal(invalid.map((s) => s.leg))
      return
    }
    if (!changed.length || pending) return
    setError(null)
    // Only the legs that changed, so a code saved on another leg elsewhere is left alone.
    const codes: LegCodes = Object.fromEntries(changed.map((s) => [s.leg, s.code]))
    startTransition(async () => {
      const res = await saveHsCodes({ sku: product.sku, codes })
      if (!res.ok) {
        setError(res.error)
        toast.error(res.error)
        return
      }
      onSaved(res.codes)
      toast.success(`HS codes saved for ${label}`)
      router.refresh()
    })
  }

  const notCountedNote = product.pricedLegs.length === 0 ? 'No transfer price yet' : 'Not sold on this leg'

  return (
    <tr className={cn('border-t border-gray-100 align-top', changed.length > 0 && 'bg-amber-50/40')} data-sku={product.sku}>
      <td className="px-4 py-2.5">
        <span className="block text-gray-900">{label}</span>
        <span className="block font-mono text-[11px] text-gray-500">{product.sku}</span>
        {changed.length > 0 && (
          <span className="mt-1 inline-block rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-900" data-testid="hs-codes-row-unsaved">
            Unsaved
          </span>
        )}
        {error && <span className="mt-1 block text-xs text-red-700">{error}</span>}
        {shown.length > 0 && (
          <span id={errorId} className="mt-1 block text-xs text-red-700" data-testid="hs-code-format-error">
            {shown.map((s) => LEG_CONFIG[s.leg].label).join(', ')}: {HS_CODE_MESSAGE}
          </span>
        )}
      </td>
      {state.map((s) => (
        <td key={s.leg} className="px-3 py-2.5">
          {canEdit ? (
            <input
              value={values[s.leg]}
              onChange={(e) => onChange(s.leg, e.target.value)}
              onBlur={() => {
                if (s.invalid) onReveal([s.leg])
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') save()
              }}
              placeholder={s.counted ? 'Not set' : notCountedNote}
              aria-label={`${LEG_CONFIG[s.leg].label} HS code for ${label}`}
              aria-invalid={s.shown || undefined}
              aria-describedby={s.shown ? errorId : undefined}
              maxLength={40}
              className={cn(
                'w-full min-w-[8rem] rounded border border-gray-300 bg-white px-2 py-1.5 font-mono text-xs text-gray-900 focus:border-echo-orange focus:outline-none',
                s.shown && 'border-red-500 focus:border-red-600',
                !s.shown && s.counted && s.code === '' && 'border-amber-300',
              )}
            />
          ) : s.code ? (
            <span className="font-mono text-xs text-gray-900">{s.code}</span>
          ) : s.counted ? (
            <span className="text-xs text-amber-700">Not set</span>
          ) : (
            <span className="text-xs text-gray-400">{notCountedNote}</span>
          )}
        </td>
      ))}
      {canEdit && (
        <td className="px-4 py-2.5 text-right">
          <button
            type="button"
            onClick={save}
            disabled={!changed.length || invalid.length > 0 || pending}
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
