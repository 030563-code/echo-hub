'use client'

// page-state: view factory:capability (BoardTable keeps its own search and sort)

import Link from 'next/link'
import type { ColumnDef } from '@tanstack/react-table'
import BoardTable from '@/components/board/BoardTable'
import { strings, type FactoryLocale } from '@/lib/factory/strings'
import type { FactoryProductCapability } from '@/lib/factory/capability-math'

/**
 * One row per product: what they can build, what caps it, what we will need,
 * and whether that adds up. No SKU column: EBH9NA is our database code and
 * means nothing to a factory, so the product name carries the row.
 *
 * 🔴 The requirement is ONE number. It used to print our firm orders, weighted
 * quotes, depot stock, in transit and on order underneath it, which is our
 * commercial position and none of their business. Dean, 18 Sep 2026. The
 * breakdown behind the name is all theirs: their parts list and their shelf.
 */
function columns(locale: FactoryLocale): ColumnDef<FactoryProductCapability, unknown>[] {
  const t = strings(locale)
  const n = (v: number) => v.toLocaleString(locale === 'sk' ? 'sk-SK' : 'en-GB')
  return [
    {
      accessorKey: 'productName',
      header: t.thProduct,
      cell: ({ row }) => (
        <div>
          <Link
            href={`/factory/stock/${encodeURIComponent(row.original.fgCode)}`}
            className="font-medium text-echo-orange underline hover:no-underline"
          >
            {row.original.productName}
          </Link>
        </div>
      ),
    },
    {
      accessorKey: 'maxBuildable',
      header: t.colCapability,
      cell: ({ row }) => (
        <span className="tabular-nums font-semibold text-gray-900">
          {row.original.maxBuildable === null ? '—' : n(row.original.maxBuildable)}
        </span>
      ),
    },
    {
      id: 'cappedBy',
      accessorFn: (row) => row.bindingDesc ?? row.bindingCode ?? '',
      header: t.colCappedBy,
      cell: ({ row }) => (
        <span className="text-gray-700">
          {row.original.bindingDesc ?? row.original.bindingCode ?? ''}
          {row.original.bindingCode && row.original.bindingDesc && (
            <span className="ml-1 font-mono text-xs text-gray-500">{row.original.bindingCode}</span>
          )}
        </span>
      ),
    },
    {
      accessorKey: 'requirement',
      header: t.colRequirement,
      cell: ({ row }) =>
        row.original.requirement === null ? (
          <span className="text-xs text-gray-500">{t.capNoForecast}</span>
        ) : (
          <span className="tabular-nums font-semibold text-gray-900">{n(row.original.requirement)}</span>
        ),
    },
    {
      id: 'status',
      accessorFn: (row) =>
        row.short ? 'short' : row.requirement === null || row.maxBuildable === null ? 'unknown' : 'ok',
      header: t.colStatus,
      cell: ({ row }) => {
        const p = row.original
        // Coloured off the computed state, never off the rendered word, so it
        // survives being read in either language.
        if (p.short) {
          return (
            <span className="rounded-full bg-red-50 px-2 py-0.5 text-xs font-semibold text-red-700">
              {t.capShort}
            </span>
          )
        }
        // No forecast is not a clean bill of health, so it says nothing at all.
        if (p.requirement === null) return <span className="text-gray-400">—</span>
        if (p.maxBuildable === null) {
          return <span className="text-xs font-medium text-gray-500">{t.capUnknown}</span>
        }
        return (
          <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-semibold text-emerald-800">
            {t.capOk}
          </span>
        )
      },
    },
  ]
}

export function FactoryCapabilityTable({
  rows,
  locale,
}: {
  rows: FactoryProductCapability[]
  locale: FactoryLocale
}) {
  const t = strings(locale)
  return (
    <BoardTable
      stateKey="factory:capability"
      data={rows}
      columns={columns(locale)}
      pageSize={25}
      searchPlaceholder={t.searchStock}
      emptyMessage={t.emptyCapability}
    />
  )
}
