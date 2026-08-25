import Link from 'next/link'
import { Button } from '@/components/ui/button'

export interface DealListRow {
  id: string
  name: string
  dateValue: string
  amountFormatted: string
  badge: { text: string; className: string }
  action: { href: string; label: string }
  pipelineLabel?: string
  probabilityLabel?: string
}

export interface DealListProps {
  rows: DealListRow[]
  dateHeader: string
  badgeHeader: string
  pipelineHeader?: string
  probabilityHeader?: string
  actionStyle?: 'button' | 'yellowOutline'
}

const badgeBase = 'inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium border'

const yellowOutlineBase =
  'inline-flex items-center justify-center font-bold uppercase tracking-wider transition-all focus:outline-none focus:ring-2 border-2 rounded-none bg-transparent text-echo-yellow border-echo-yellow hover:bg-echo-yellow/10 focus:ring-echo-yellow/50'

export function DealList({
  rows,
  dateHeader,
  badgeHeader,
  pipelineHeader,
  probabilityHeader,
  actionStyle = 'button',
}: DealListProps) {
  return (
    <div className="bg-white border border-gray-200 rounded-lg overflow-hidden shadow-sm">
      {/* md and up: the original table, scrollable sideways if it ever overflows */}
      <div className="hidden md:block overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="bg-black text-white uppercase text-xs tracking-wider">
            <tr>
              <th className="px-4 lg:px-6 py-4 font-medium">Deal Name</th>
              {pipelineHeader && <th className="px-4 lg:px-6 py-4 font-medium">{pipelineHeader}</th>}
              <th className="px-4 lg:px-6 py-4 font-medium">{dateHeader}</th>
              <th className="px-4 lg:px-6 py-4 font-medium text-right">Amount</th>
              <th className="px-4 lg:px-6 py-4 font-medium text-center">{badgeHeader}</th>
              {probabilityHeader && <th className="px-4 lg:px-6 py-4 font-medium text-right">{probabilityHeader}</th>}
              <th className="px-4 lg:px-6 py-4 font-medium text-right">Action</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {rows.map((row) => (
              <tr key={row.id} className="hover:bg-gray-50 transition-colors">
                <td className="px-4 lg:px-6 py-4 font-medium text-gray-900">{row.name}</td>
                {pipelineHeader && (
                  <td className="px-4 lg:px-6 py-4 text-gray-500 text-xs">{row.pipelineLabel}</td>
                )}
                <td className="px-4 lg:px-6 py-4 text-gray-500">{row.dateValue}</td>
                <td className="px-4 lg:px-6 py-4 text-right font-mono text-gray-700">{row.amountFormatted}</td>
                <td className="px-4 lg:px-6 py-4 text-center">
                  <span className={`${badgeBase} ${row.badge.className}`}>{row.badge.text}</span>
                </td>
                {probabilityHeader && (
                  <td className="px-4 lg:px-6 py-4 text-right">
                    <span className="text-xs text-gray-500 font-mono">{row.probabilityLabel}</span>
                  </td>
                )}
                <td className="px-4 lg:px-6 py-4 text-right">
                  {actionStyle === 'yellowOutline' ? (
                    <Link
                      href={row.action.href}
                      className={`${yellowOutlineBase} px-3 py-1.5 text-xs h-8`}
                    >
                      {row.action.label}
                    </Link>
                  ) : (
                    <Link href={row.action.href}>
                      <Button variant="outline" size="sm" className="text-xs h-8">
                        {row.action.label}
                      </Button>
                    </Link>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* below md: stacked list, same data */}
      <ul className="md:hidden divide-y divide-gray-100">
        {rows.map((row) => (
          <li key={row.id} className="p-4 space-y-3">
            <div className="flex items-start justify-between gap-3">
              <p className="min-w-0 flex-1 truncate font-medium text-gray-900">{row.name}</p>
              <p className="shrink-0 text-right font-mono text-gray-700">{row.amountFormatted}</p>
            </div>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-gray-500">
              <span>{row.dateValue}</span>
              <span className={`${badgeBase} ${row.badge.className}`}>{row.badge.text}</span>
              {row.pipelineLabel && <span className="text-xs">{row.pipelineLabel}</span>}
              {row.probabilityLabel && <span className="text-xs font-mono">{row.probabilityLabel}</span>}
            </div>
            {actionStyle === 'yellowOutline' ? (
              <Link href={row.action.href} className={`${yellowOutlineBase} h-11 w-full text-xs`}>
                {row.action.label}
              </Link>
            ) : (
              <Link href={row.action.href} className="block w-full">
                <Button variant="outline" size="sm" className="h-11 w-full text-xs">
                  {row.action.label}
                </Button>
              </Link>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}
