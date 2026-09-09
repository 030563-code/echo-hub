'use client'

// page-state: none (every value here lives in the caller's persisted board
// view, which is what user_page_state stores. This component only renders it.)

import { LIFECYCLE_STAGES, type LifecycleStage } from '@/lib/po-lifecycle'
import { entityLabel } from '@/lib/depot-constants'
import { legLabel } from '@/lib/po-number'
import { activePoFilterCount, EMPTY_PO_FILTERS, type PoFilters } from '@/lib/po-filters'

/**
 * Search and advanced filters for the purchase order board.
 *
 * The SEARCH BOX IS ALWAYS VISIBLE and the advanced filters fold away. A
 * collapsed disclosure reading just "Filters" is what made Jillian report the
 * quotes Hub as having no search at all, so search never hides here; but seven
 * rows of chips left permanently open pushed the board itself below the fold,
 * which is its own way of hiding the work.
 *
 * The count badge sits on the closed summary, so a board narrowed by filters
 * somebody set last week cannot look like a board with nothing on it.
 *
 * Multi-selects are chip toggles rather than a `<select multiple>`: nobody
 * discovers ctrl-click, and on a phone a multiple select is close to unusable.
 */

const STATUSES: Array<{ value: string; label: string }> = [
  { value: 'requested', label: 'Requested' },
  { value: 'approved', label: 'Approved' },
  { value: 'rejected', label: 'Rejected' },
  { value: 'sro_evaluating', label: 'SRO evaluating' },
  { value: 'fulfilling_from_stock', label: 'From stock' },
  { value: 'in_manufacturing', label: 'Manufacturing' },
  { value: 'ready_for_shipment', label: 'Ready for shipment' },
  { value: 'shipped', label: 'Shipped' },
  { value: 'delivered', label: 'Delivered' },
  { value: 'cancelled', label: 'Cancelled' },
]

const LEGS = ['DEPOT_TO_EB_GROUP', 'EB_GROUP_TO_SRO', 'SRO_TO_SUPPLIER', 'SRO_TO_CARGO']

const FULFILMENT = [
  { value: 'stock', label: 'From stock' },
  { value: 'manufacture', label: 'Manufactured' },
]

const LABEL = 'block text-[11px] font-semibold uppercase tracking-wide text-gray-500 mb-1.5'
const CHIP_ON =
  'rounded-full border border-echo-orange bg-echo-orange px-2.5 py-1 text-xs font-medium text-white transition-colors'
const CHIP_OFF =
  'rounded-full border border-gray-300 bg-white px-2.5 py-1 text-xs text-gray-700 hover:bg-gray-100 transition-colors'
const DATE =
  'rounded-lg border border-gray-300 bg-white px-2.5 py-1.5 text-xs text-gray-900 focus:border-echo-orange focus:outline-none focus:ring-1 focus:ring-echo-orange'

/** One row of toggles. Clicking a chip adds or removes it from `selected`. */
function ChipGroup({
  label,
  options,
  selected,
  onChange,
}: {
  label: string
  options: Array<{ value: string; label: string }>
  selected: string[]
  onChange: (next: string[]) => void
}) {
  const set = new Set(selected)
  return (
    <div>
      <span className={LABEL}>{label}</span>
      <div className="flex flex-wrap gap-1.5">
        {options.map((o) => {
          const on = set.has(o.value)
          return (
            <button
              key={o.value}
              type="button"
              aria-pressed={on}
              onClick={() => onChange(on ? selected.filter((v) => v !== o.value) : [...selected, o.value])}
              className={on ? CHIP_ON : CHIP_OFF}
            >
              {o.label}
            </button>
          )
        })}
      </div>
    </div>
  )
}

export default function PoFilterBar({
  filters,
  onChange,
  entities,
  showing,
  total,
}: {
  filters: PoFilters
  onChange: (next: PoFilters) => void
  /** Entity codes actually present on the board, so the list is never a wish. */
  entities: string[]
  showing: number
  total: number
}) {
  const active = activePoFilterCount(filters)
  const set = <K extends keyof PoFilters>(key: K, value: PoFilters[K]) =>
    onChange({ ...filters, [key]: value })

  return (
    <div className="rounded-xl border border-gray-200 bg-white">
      <div className="flex flex-wrap items-center gap-3 px-4 py-3">
        <input
          id="po-q"
          aria-label="Search purchase orders"
          value={filters.q}
          onChange={(e) => set('q', e.target.value)}
          placeholder="Search PO number, reference, entity, SKU, product..."
          className="min-w-0 flex-1 rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 focus:border-echo-orange focus:outline-none focus:ring-1 focus:ring-echo-orange"
        />
        {/*
          Say what is hidden. A filter that quietly removes work is worse than
          no filter, because the board then reads as "there is nothing to do".
        */}
        {showing !== total && (
          <span className="text-xs text-gray-500">
            showing {showing} of {total}
          </span>
        )}
      </div>

      <details className="border-t border-gray-200">
      <summary className="cursor-pointer select-none px-4 py-2.5 text-sm font-medium text-gray-700">
        Advanced filters
        {active > 0 && (
          <span className="ml-2 rounded-full bg-echo-orange px-2 py-0.5 text-[11px] font-semibold text-white">
            {active}
          </span>
        )}
      </summary>

      <div className="grid gap-4 border-t border-gray-200 px-4 py-4">
        <ChipGroup
          label="Status"
          options={STATUSES}
          selected={filters.statuses}
          onChange={(v) => set('statuses', v)}
        />

        <ChipGroup
          label="Board column"
          options={LIFECYCLE_STAGES.map((s) => ({ value: s.key, label: s.label }))}
          selected={filters.stages}
          onChange={(v) => set('stages', v as LifecycleStage[])}
        />

        <div className="grid gap-4 sm:grid-cols-2">
          <ChipGroup
            label="Leg"
            options={LEGS.map((l) => ({ value: l, label: legLabel(l) }))}
            selected={filters.legs}
            onChange={(v) => set('legs', v)}
          />
          <ChipGroup
            label="Fulfilment"
            options={FULFILMENT}
            selected={filters.fulfilment}
            onChange={(v) => set('fulfilment', v)}
          />
        </div>

        {entities.length > 0 && (
          <ChipGroup
            label="Entity, either end"
            options={entities.map((e) => ({ value: e, label: entityLabel(e) }))}
            selected={filters.entities}
            onChange={(v) => set('entities', v)}
          />
        )}

        <div className="flex flex-wrap items-end gap-4">
          <div>
            <label className={LABEL} htmlFor="po-from">
              Raised from
            </label>
            <input
              id="po-from"
              type="date"
              value={filters.from}
              onChange={(e) => set('from', e.target.value)}
              className={DATE}
            />
          </div>
          <div>
            <label className={LABEL} htmlFor="po-to">
              Raised to
            </label>
            <input
              id="po-to"
              type="date"
              value={filters.to}
              onChange={(e) => set('to', e.target.value)}
              className={DATE}
            />
          </div>
          {active > 0 && (
            <button
              type="button"
              onClick={() => onChange(EMPTY_PO_FILTERS)}
              className="ml-auto rounded-lg border border-gray-300 px-3 py-1.5 text-xs text-gray-700 hover:bg-gray-100 transition-colors"
            >
              Clear all
            </button>
          )}
        </div>
      </div>
      </details>
    </div>
  )
}
