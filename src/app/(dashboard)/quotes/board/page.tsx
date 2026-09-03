import Link from 'next/link'
import { requireCapability } from '@/lib/authz'
import { getDealsForBoard, type BoardScope } from '@/app/actions/hubspot/getDealsForBoard'
import { DealsBoard } from '@/components/quotes/deals-board'
import { PIPELINE_CONFIG } from '@/lib/pipeline-config'
import { Card } from '@/components/ui/card'

export const dynamic = 'force-dynamic'

/**
 * The deals board. Dean's words: "Hubspot has the very nice kanban style view
 * of the deals which similar to the Purchase order style which we should
 * replicate. Dave should have access to also view all the deals in Hubspot
 * where it also shows the hubspot team pipeline associated with it."
 *
 * Replaces the Pending tab, which painted every row one grey badge reading
 * "Pending" whatever stage the deal was actually at.
 *
 * Scope and pipeline live in the URL so a view is linkable, and both are
 * re-decided server-side: a rep who edits either gets their own deals in their
 * own region back.
 */
export default async function DealsBoardPage({
  searchParams,
}: {
  searchParams: Promise<{ scope?: string; pipeline?: string; window?: string }>
}) {
  await requireCapability(['quotes.view', 'quotes.create'])
  const params = await searchParams

  const windowDays = Number(params.window) || 60
  const result = await getDealsForBoard({
    scope: params.scope === 'all' ? 'all' : 'mine',
    pipelineId: params.pipeline,
    windowDays,
  })

  if (!result.success || !result.groups) {
    return (
      <Card className="bg-white border-gray-200">
        <h1 className="text-lg font-semibold text-gray-900">Board</h1>
        <p className="mt-2 text-sm text-red-700">{result.error}</p>
      </Card>
    )
  }

  const scope: BoardScope = result.scope ?? 'mine'
  const link = (next: Record<string, string>) => {
    const q = new URLSearchParams({
      scope,
      ...(result.pipelineId ? { pipeline: result.pipelineId } : {}),
      window: String(windowDays),
      ...next,
    })
    return `/quotes/board?${q.toString()}`
  }

  const chip = (active: boolean) =>
    active
      ? 'rounded border border-echo-yellow bg-yellow-50 px-2.5 py-1 text-xs font-semibold text-gray-900'
      : 'rounded border border-gray-200 px-2.5 py-1 text-xs text-gray-600 hover:border-gray-300'

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Board</h1>
          <p className="text-sm text-gray-600">
            Deals by their real HubSpot stage. Drag a card, or use Move on it, to change stage.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {result.isAdmin && (
            <div className="flex items-center gap-1">
              <Link href={link({ scope: 'mine' })} className={chip(scope === 'mine')}>My deals</Link>
              <Link href={link({ scope: 'all' })} className={chip(scope === 'all')}>All reps</Link>
            </div>
          )}
          <div className="flex items-center gap-1">
            {[30, 60, 120, 365].map((days) => (
              <Link key={days} href={link({ window: String(days) })} className={chip(windowDays === days)}>
                {days === 365 ? '1 year' : `${days}d`}
              </Link>
            ))}
          </div>
          {result.isAdmin && (
            <form action="/quotes/board" method="get" className="flex items-center gap-1">
              <input type="hidden" name="scope" value={scope} />
              <input type="hidden" name="window" value={windowDays} />
              <select
                name="pipeline"
                defaultValue={result.pipelineId}
                className="rounded border border-gray-300 bg-white px-2 py-1 text-xs text-gray-900"
              >
                {PIPELINE_CONFIG.map((p) => (
                  <option key={p.pipelineId} value={p.pipelineId}>{p.label}</option>
                ))}
              </select>
              <button type="submit" className={chip(false)}>Go</button>
            </form>
          )}
        </div>
      </div>

      <DealsBoard groups={result.groups} owners={result.owners} showOwner={scope === 'all'} />

      {result.truncated && (
        <p className="text-xs text-gray-500">
          Showing the most recently updated deals only. Widen the window, or use the All tab for the
          full list.
        </p>
      )}
    </div>
  )
}
