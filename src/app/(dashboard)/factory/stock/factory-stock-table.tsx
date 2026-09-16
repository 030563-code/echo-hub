'use client'

// page-state: view factory:stock (BoardTable keeps its own search and sort)

import type { ColumnDef } from '@tanstack/react-table'
import BoardTable from '@/components/board/BoardTable'
import { availabilityLabel, availabilityTone } from '@/lib/factory/status'
import { factoryDate, strings, type FactoryLocale } from '@/lib/factory/strings'
import type { FactoryStockRow } from '@/lib/factory/stock'

/**
 * Six columns, and never available_quantity or reserved: those are quantity
 * minus reservations their system accumulates and never drains, so they read
 * deeply negative against stock physically on the shelf.
 */
function columns(locale: FactoryLocale): ColumnDef<FactoryStockRow, unknown>[] {
  const t = strings(locale)
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
      <span className="tabular-nums font-semibold text-gray-900">{row.original.quantity ?? 0}</span>
    ),
  },
  { accessorKey: 'unit', header: t.colUnit, cell: ({ row }) => <span className="text-gray-600">{row.original.unit ?? ''}</span> },
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
    accessorKey: 'last_synced_at',
    header: t.colUpdated,
    cell: ({ row }) => (
      <span className="whitespace-nowrap text-xs text-gray-500">
        {factoryDate(row.original.last_synced_at, locale, { day: 'numeric', month: 'short' })}
      </span>
    ),
  },
  ]
}

export function FactoryStockTable({ rows, locale }: { rows: FactoryStockRow[]; locale: FactoryLocale }) {
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
