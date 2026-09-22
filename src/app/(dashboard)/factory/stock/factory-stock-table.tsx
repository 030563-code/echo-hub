'use client'

// page-state: view factory:stock (BoardTable keeps its own search and sort)

import type { ColumnDef } from '@tanstack/react-table'
import BoardTable from '@/components/board/BoardTable'
import { availabilityLabel, availabilityTone } from '@/lib/factory/status'
import { factoryDate, strings, type FactoryLocale } from '@/lib/factory/strings'
import type { FactoryStockRow } from '@/lib/factory/stock'
import type { MaterialNeed } from '@/lib/factory/capability-math'

/**
 * A row of the feed with what our current requirement draws on it. The two
 * extra columns are the CEO's "alert the warehouse when the stock of any
 * material runs low" (18 Sep 2026): the minimum is what our forecast needs,
 * and a row goes amber when the shelf cannot cover it.
 */
export type FactoryStockLine = FactoryStockRow & { need: MaterialNeed | null }

/**
 * Eight columns, and never available_quantity or reserved: those are quantity
 * minus reservations their system accumulates and never drains, so they read
 * deeply negative against stock physically on the shelf.
 */
function columns(locale: FactoryLocale): ColumnDef<FactoryStockLine, unknown>[] {
  const t = strings(locale)
  const n = (v: number) => Number(v.toFixed(2)).toLocaleString(locale === 'sk' ? 'sk-SK' : 'en-GB')
  return [
  {
    accessorKey: 'ns_number',
    header: t.colCode,
    cell: ({ row }) => <span className="font-mono text-xs text-gray-600">{row.original.ns_number}</span>,
  },
  { accessorKey: 'item_name', header: t.colItem, cell: ({ row }) => <span className="text-gray-900">{row.original.item_name}</span> },
  {
    accessorKey: 'quantity',
    header: t.colQuantity,
    cell: ({ row }) => (
      <span className="tabular-nums font-semibold text-gray-900">{Math.max(0, row.original.quantity ?? 0)}</span>
    ),
  },
  { accessorKey: 'unit', header: t.colUnit, cell: ({ row }) => <span className="text-gray-600">{row.original.unit ?? ''}</span> },
  {
    id: 'needed',
    accessorFn: (row) => row.need?.needed ?? 0,
    header: t.colNeeded,
    cell: ({ row }) => {
      const need = row.original.need
      if (!need || need.needed <= 0) return <span className="text-gray-300">0</span>
      return (
        <span className="tabular-nums text-gray-900" title={need.products.join(', ')}>
          {n(need.needed)}
        </span>
      )
    },
  },
  {
    id: 'short',
    accessorFn: (row) => row.need?.short ?? 0,
    header: t.colShortBy,
    cell: ({ row }) => {
      const short = row.original.need?.short ?? 0
      if (short <= 0) return <span className="text-gray-300">0</span>
      return (
        <span className="rounded-full bg-amber-50 px-2 py-0.5 text-xs font-semibold tabular-nums text-amber-800">
          {n(short)}
        </span>
      )
    },
  },
  {
    id: 'availability',
    accessorFn: (row) => availabilityLabel(row.availability, locale),
    header: t.colStatus,
    cell: ({ row }) => {
      // The colour comes from the feed's own value, never from the rendered
      // word, so it survives being read in either language.
      const tone = availabilityTone(row.original.availability)
      const skin =
        tone === 'sold_out' ? 'text-red-700' : tone === 'last_pieces' ? 'text-amber-700' : 'text-gray-600'
      return (
        <span className={`text-xs font-medium ${skin}`}>
          {availabilityLabel(row.original.availability, locale)}
        </span>
      )
    },
  },
  {
    // The day the FIGURES last moved, not the day the sync ran. Until 18 Sep
    // 2026 this printed the sync time, which said "today" on six-week-old data.
    accessorKey: 'last_changed_at',
    header: t.colUpdated,
    cell: ({ row }) => (
      <span className="whitespace-nowrap text-xs text-gray-500">
        {factoryDate(row.original.last_changed_at ?? row.original.last_synced_at, locale, {
          day: 'numeric',
          month: 'short',
        })}
      </span>
    ),
  },
  ]
}

export function FactoryStockTable({ rows, locale }: { rows: FactoryStockLine[]; locale: FactoryLocale }) {
  const t = strings(locale)
  return (
    <BoardTable
      stateKey="factory:stock"
      data={rows}
      columns={columns(locale)}
      pageSize={50}
      searchPlaceholder={t.searchStock}
      emptyMessage={t.emptyStock}
    />
  )
}
