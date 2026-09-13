'use client'

// page-state: view stock-board:reconciliation (BoardTable keeps its own search and sort)

import type { ColumnDef } from '@tanstack/react-table'
import BoardTable from '@/components/board/BoardTable'
import StatusBadge from '@/components/board/StatusBadge'
import type { LedgerGap } from '@/lib/stock/reconcile'

const COLUMNS: ColumnDef<LedgerGap, unknown>[] = [
  {
    accessorKey: 'since',
    header: 'Since',
    cell: ({ row }) => (
      <span className="whitespace-nowrap text-gray-600">
        {row.original.since
          ? new Date(row.original.since).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
          : '—'}
      </span>
    ),
  },
  { accessorKey: 'kind', header: 'Missing movement', cell: ({ row }) => <StatusBadge status={row.original.kind} /> },
  {
    accessorKey: 'label',
    header: 'What happened',
    cell: ({ row }) => {
      const g = row.original
      return g.href ? (
        <a href={g.href} className="underline hover:no-underline">{g.label}</a>
      ) : (
        <span>{g.label}</span>
      )
    },
  },
  { accessorKey: 'ref_id', header: 'Ref', cell: ({ row }) => <span className="font-mono text-xs text-gray-500">{row.original.ref_type} {row.original.ref_id.slice(0, 8)}</span> },
]

export default function ReconciliationBoard({ gaps }: { gaps: LedgerGap[] }) {
  return (
    <div className="space-y-4">
      <p className="text-sm text-gray-600">
        Events that should have moved stock and did not: an invoice sent with no dispatch, a booked chain with nothing
        deducted at s.r.o., a finished Bamida order with nothing added, a receipt not on the ledger. The hooks log and
        carry on rather than fail the business step, so this is where a missed one shows. Record an adjustment on the
        Finished goods tab to close a gap.
      </p>
      <BoardTable
        stateKey="stock-board:reconciliation"
        data={gaps}
        columns={COLUMNS}
        pageSize={50}
        searchPlaceholder="Search by PO, invoice or SKU…"
        emptyMessage="Nothing to reconcile. Every recorded event has its movement."
      />
    </div>
  )
}
