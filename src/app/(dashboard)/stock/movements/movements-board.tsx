'use client'

// page-state: view stock-board:movements (BoardTable keeps its own search and sort)

import type { ColumnDef } from '@tanstack/react-table'
import BoardTable from '@/components/board/BoardTable'
import StatusBadge from '@/components/board/StatusBadge'
import type { MovementRow } from '@/lib/stock/board-data'

const COLUMNS: ColumnDef<MovementRow, unknown>[] = [
  {
    accessorKey: 'created_at',
    header: 'When',
    cell: ({ row }) => (
      <span className="whitespace-nowrap text-gray-600">
        {new Date(row.original.created_at).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
      </span>
    ),
  },
  { accessorKey: 'warehouse_code', header: 'Warehouse', cell: ({ row }) => <span className="font-mono text-xs">{row.original.warehouse_code}</span> },
  {
    accessorKey: 'sku',
    header: 'SKU / component',
    cell: ({ row }) => (
      <span className="font-mono text-xs text-echo-orange">
        {row.original.sku}
        {row.original.item_kind === 'material' && <span className="ml-1 text-gray-400">material</span>}
      </span>
    ),
  },
  { accessorKey: 'kind', header: 'Kind', cell: ({ row }) => <StatusBadge status={row.original.kind} /> },
  {
    accessorKey: 'quantity',
    header: 'Qty',
    cell: ({ row }) => (
      <span className={`tabular-nums font-semibold ${row.original.quantity < 0 ? 'text-red-700' : 'text-emerald-700'}`}>
        {row.original.quantity > 0 ? `+${row.original.quantity}` : row.original.quantity}
      </span>
    ),
  },
  { accessorKey: 'balance_after', header: 'Balance after', cell: ({ row }) => <span className="tabular-nums">{row.original.balance_after}</span> },
  {
    accessorKey: 'ref_type',
    header: 'Ref',
    cell: ({ row }) => {
      const m = row.original
      const href = m.ref_type === 'po_shipment' || m.ref_type === 'po_manufacturing' ? `/purchase-orders/${m.ref_id}` : null
      const label = m.ref_type.replace(/_/g, ' ')
      return href ? (
        <a href={href} className="text-xs underline hover:no-underline">{label}</a>
      ) : (
        <span className="text-xs text-gray-500">{label}</span>
      )
    },
  },
  { accessorKey: 'estimated', header: 'Est.', cell: ({ row }) => (row.original.estimated ? <span className="text-xs text-amber-700">estimated</span> : null) },
  { accessorKey: 'created_by', header: 'By', cell: ({ row }) => <span className="text-xs text-gray-600">{row.original.created_by ?? 'the Hub'}</span> },
  { accessorKey: 'note', header: 'Note', cell: ({ row }) => <span className="text-xs text-gray-600">{row.original.note ?? ''}</span> },
]

export default function MovementsBoard({ rows }: { rows: MovementRow[] }) {
  return (
    <BoardTable
      stateKey="stock-board:movements"
      data={rows}
      columns={COLUMNS}
      pageSize={50}
      searchPlaceholder="Search SKU, warehouse, kind or note…"
      emptyMessage="No movements yet. The first count or receipt will appear here."
    />
  )
}
