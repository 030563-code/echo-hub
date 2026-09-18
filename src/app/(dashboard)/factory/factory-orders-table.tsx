'use client'

// page-state: view factory:orders (BoardTable keeps its own search and sort)

import { useState, useTransition } from 'react'
import Link from 'next/link'
import { Download } from 'lucide-react'
import type { ColumnDef } from '@tanstack/react-table'
import BoardTable from '@/components/board/BoardTable'
import { displayPoNumber } from '@/lib/po-number'
import { downloadFactoryOrderPdf, downloadFactoryPricedOrderPdf } from '@/app/actions/factory/orders'
import { factoryStatus, factoryStatusLabel } from '@/lib/factory/status'
import { factoryDate, fill, strings, type FactoryLocale } from '@/lib/factory/strings'
import { saveFactoryPdf } from '@/lib/factory/save-pdf'
import type { FactoryOrder } from '@/lib/factory/orders'

/**
 * Both documents on the row, so the manufacturer does not have to open an order
 * to get at them. Dean, 18 Sep 2026: "push the priced PO to the manufacturing
 * page too". The same two downloads are inside the order as step 1, and both
 * call the same gated actions; this is a shortcut, never a second way in.
 */
function DocumentButtons({ poId, locale }: { poId: string; locale: FactoryLocale }) {
  const t = strings(locale)
  const [pending, startTransition] = useTransition()
  const [failed, setFailed] = useState(false)

  const get = (action: typeof downloadFactoryOrderPdf) => () => {
    setFailed(false)
    startTransition(async () => {
      const res = await action({ poId })
      // The row has no room for a sentence, so a failure says so quietly here
      // and the order page gives the real reason.
      if (!res.ok) return setFailed(true)
      saveFactoryPdf(res)
    })
  }

  const chip =
    'inline-flex items-center gap-1 rounded-md border border-gray-300 bg-white px-2 py-1 text-xs font-medium text-gray-700 transition-colors hover:bg-gray-50 disabled:opacity-50'

  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap gap-1">
        <button onClick={get(downloadFactoryOrderPdf)} disabled={pending} className={chip}>
          <Download className="h-3 w-3" />
          {t.docOrder}
        </button>
        <button onClick={get(downloadFactoryPricedOrderPdf)} disabled={pending} className={chip}>
          <Download className="h-3 w-3" />
          {t.docPriced}
        </button>
      </div>
      {failed && <span className="text-xs text-red-700">{t.docFailed}</span>}
    </div>
  )
}

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
  {
    id: 'documents',
    // Not sortable or searchable on purpose: it is two buttons, not a value.
    enableSorting: false,
    enableGlobalFilter: false,
    header: t.colDocuments,
    cell: ({ row }) => <DocumentButtons poId={row.original.po_id} locale={locale} />,
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
