'use client'

// page-state: view factory:orders (BoardTable keeps its own search and sort)

import Link from 'next/link'
import type { ColumnDef } from '@tanstack/react-table'
import BoardTable from '@/components/board/BoardTable'
import { displayPoNumber } from '@/lib/po-number'
import { FACTORY_STATUS_LABELS, factoryStatus } from '@/lib/factory/status'
import type { FactoryOrder } from '@/lib/factory/orders'

const DAY = { day: 'numeric', month: 'short', year: 'numeric' } as const

function shortDate(value: string | null): string {
  return value ? new Date(value).toLocaleDateString('en-GB', DAY) : ''
}

/** Amber until they have answered us, green once the work is done. */
function StatusPill({ order }: { order: FactoryOrder }) {
  const status = factoryStatus(order)
  const skin =
    status === 'finished'
      ? 'bg-emerald-50 text-emerald-800 border-emerald-200'
      : status === 'in_production'
        ? 'bg-blue-50 text-blue-800 border-blue-200'
        : status === 'confirmed'
          ? 'bg-gray-50 text-gray-700 border-gray-200'
          : 'bg-amber-50 text-amber-900 border-amber-200'
  return (
    <span className={`inline-flex whitespace-nowrap rounded-full border px-2.5 py-0.5 text-xs font-semibold ${skin}`}>
      {FACTORY_STATUS_LABELS[status]}
    </span>
  )
}

const COLUMNS: ColumnDef<FactoryOrder, unknown>[] = [
  {
    id: 'po_number',
    accessorFn: (row) => displayPoNumber(row.po_number),
    header: 'Purchase order',
    cell: ({ row }) => (
      <Link href={`/factory/${row.original.po_id}`} className="font-semibold text-echo-orange underline hover:no-underline">
        {displayPoNumber(row.original.po_number)}
      </Link>
    ),
  },
  {
    id: 'products',
    accessorFn: (row) => row.lines.map((l) => l.product_name ?? l.sku ?? '').join(' '),
    header: 'Products',
    cell: ({ row }) => {
      const lines = row.original.lines
      const first = lines[0]
      if (!first) return <span className="text-gray-400">No lines</span>
      return (
        <span className="text-gray-900">
          {first.product_name || first.sku}
          {lines.length > 1 && <span className="text-gray-500"> and {lines.length - 1} more</span>}
        </span>
      )
    },
  },
  {
    id: 'quantity',
    accessorFn: (row) => row.lines.reduce((total, line) => total + (line.quantity ?? 0), 0),
    header: 'Units',
    cell: ({ row }) => (
      <span className="tabular-nums">
        {row.original.lines.reduce((total, line) => total + (line.quantity ?? 0), 0)}
      </span>
    ),
  },
  { id: 'sent_at', accessorFn: (row) => row.sent_at ?? '', header: 'Sent to you', cell: ({ row }) => <span className="whitespace-nowrap text-gray-600">{shortDate(row.original.sent_at)}</span> },
  { id: 'est_start', accessorFn: (row) => row.est_start ?? '', header: 'Start', cell: ({ row }) => <span className="whitespace-nowrap text-gray-600">{shortDate(row.original.est_start)}</span> },
  { id: 'est_finish', accessorFn: (row) => row.est_finish ?? '', header: 'Finish', cell: ({ row }) => <span className="whitespace-nowrap text-gray-600">{shortDate(row.original.est_finish)}</span> },
  {
    id: 'status',
    accessorFn: (row) => FACTORY_STATUS_LABELS[factoryStatus(row)],
    header: 'Status',
    cell: ({ row }) => <StatusPill order={row.original} />,
  },
]

export function FactoryOrdersTable({ rows }: { rows: FactoryOrder[] }) {
  return (
    <BoardTable
      stateKey="factory:orders"
      data={rows}
      columns={COLUMNS}
      pageSize={25}
      searchPlaceholder="Search by order number or product…"
      emptyMessage="No orders yet. An order appears here the moment it is sent to you."
    />
  )
}
