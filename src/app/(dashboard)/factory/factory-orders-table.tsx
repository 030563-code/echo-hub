'use client'

// page-state: view factory:orders (BoardTable keeps its own search and sort)

import Link from 'next/link'
import type { ColumnDef } from '@tanstack/react-table'
import BoardTable from '@/components/board/BoardTable'
import { displayPoNumber } from '@/lib/po-number'
import { factoryStatus, factoryStatusLabel } from '@/lib/factory/status'
import { factoryDate, fill, strings, type FactoryLocale } from '@/lib/factory/strings'
import type { FactoryOrder } from '@/lib/factory/orders'

/** Amber until they have answered us, green once the work is done. */
function StatusPill({ order, locale }: { order: FactoryOrder; locale: FactoryLocale }) {
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
      {factoryStatusLabel(status, locale)}
    </span>
  )
}

/**
 * Built per locale rather than once at module load: the headers, the empty
 * message and the status text are all language, and a table defined at import
 * time would freeze whichever language happened to load first.
 */
function columns(locale: FactoryLocale): ColumnDef<FactoryOrder, unknown>[] {
  const t = strings(locale)
  const shortDate = (value: string | null) => factoryDate(value, locale)
  return [
  {
    id: 'po_number',
    accessorFn: (row) => displayPoNumber(row.po_number),
    header: t.colPurchaseOrder,
    cell: ({ row }) => (
      <Link href={`/factory/${row.original.po_id}`} className="font-semibold text-echo-orange underline hover:no-underline">
        {displayPoNumber(row.original.po_number)}
      </Link>
    ),
  },
  {
    id: 'products',
    accessorFn: (row) => row.lines.map((l) => l.product_name ?? l.sku ?? '').join(' '),
    header: t.colProducts,
    cell: ({ row }) => {
      const lines = row.original.lines
      const first = lines[0]
      if (!first) return <span className="text-gray-400">{t.noLines}</span>
      return (
        <span className="text-gray-900">
          {first.product_name || first.sku}
          {lines.length > 1 && (
            <span className="text-gray-500"> {fill(t.andMore, { count: lines.length - 1 })}</span>
          )}
        </span>
      )
    },
  },
  {
    id: 'quantity',
    accessorFn: (row) => row.lines.reduce((total, line) => total + (line.quantity ?? 0), 0),
    header: t.colUnits,
    cell: ({ row }) => (
      <span className="tabular-nums">
        {row.original.lines.reduce((total, line) => total + (line.quantity ?? 0), 0)}
      </span>
    ),
  },
  { id: 'sent_at', accessorFn: (row) => row.sent_at ?? '', header: t.colSentToYou, cell: ({ row }) => <span className="whitespace-nowrap text-gray-600">{shortDate(row.original.sent_at)}</span> },
  { id: 'est_start', accessorFn: (row) => row.est_start ?? '', header: t.colStart, cell: ({ row }) => <span className="whitespace-nowrap text-gray-600">{shortDate(row.original.est_start)}</span> },
  { id: 'est_finish', accessorFn: (row) => row.est_finish ?? '', header: t.colFinish, cell: ({ row }) => <span className="whitespace-nowrap text-gray-600">{shortDate(row.original.est_finish)}</span> },
  {
    id: 'status',
    accessorFn: (row) => factoryStatusLabel(factoryStatus(row), locale),
    header: t.colStatus,
    cell: ({ row }) => <StatusPill order={row.original} locale={locale} />,
    },
  ]
}

export function FactoryOrdersTable({ rows, locale }: { rows: FactoryOrder[]; locale: FactoryLocale }) {
  const t = strings(locale)
  return (
    <BoardTable
      stateKey="factory:orders"
      data={rows}
      columns={columns(locale)}
      pageSize={25}
      searchPlaceholder={t.searchOrders}
      emptyMessage={t.emptyOrders}
    />
  )
}
