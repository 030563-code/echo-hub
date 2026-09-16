'use client'

// page-state: view factory:stock (BoardTable keeps its own search and sort)

import type { ColumnDef } from '@tanstack/react-table'
import BoardTable from '@/components/board/BoardTable'
import { availabilityLabel } from '@/lib/factory/status'
import type { FactoryStockRow } from '@/lib/factory/stock'

/**
 * Six columns, and never available_quantity or reserved: those are quantity
 * minus reservations their system accumulates and never drains, so they read
 * deeply negative against stock physically on the shelf.
 */
const COLUMNS: ColumnDef<FactoryStockRow, unknown>[] = [
  {
    accessorKey: 'ns_number',
    header: 'Code',
    cell: ({ row }) => <span className="font-mono text-xs text-gray-600">{row.original.ns_number}</span>,
  },
  { accessorKey: 'item_name', header: 'Item', cell: ({ row }) => <span className="text-gray-900">{row.original.item_name}</span> },
  {
    accessorKey: 'quantity',
    header: 'Quantity',
    cell: ({ row }) => (
      <span className="tabular-nums font-semibold text-gray-900">{row.original.quantity ?? 0}</span>
    ),
  },
  { accessorKey: 'unit', header: 'Unit', cell: ({ row }) => <span className="text-gray-600">{row.original.unit ?? ''}</span> },
  {
    id: 'availability',
    accessorFn: (row) => availabilityLabel(row.availability),
    header: 'Status',
    cell: ({ row }) => {
      const label = availabilityLabel(row.original.availability)
      const skin =
        label === 'Sold out'
          ? 'text-red-700'
          : label === 'Last pieces'
            ? 'text-amber-700'
            : 'text-gray-600'
      return <span className={`text-xs font-medium ${skin}`}>{label}</span>
    },
  },
  {
    accessorKey: 'last_synced_at',
    header: 'Updated',
    cell: ({ row }) => (
      <span className="whitespace-nowrap text-xs text-gray-500">
        {new Date(row.original.last_synced_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}
      </span>
    ),
  },
]

export function FactoryStockTable({ rows }: { rows: FactoryStockRow[] }) {
  return (
    <BoardTable
      stateKey="factory:stock"
      data={rows}
      columns={COLUMNS}
      pageSize={50}
      searchPlaceholder="Search by code or item…"
      emptyMessage="No stock has come through from your system yet."
    />
  )
}
