import type { CargoEventRow } from '@/lib/cargo/payload'

/**
 * The milestone history.
 *
 * A forecast and a fact are drawn differently on purpose. The forwarder mixes
 * them in one array with no flag, and reading them as one list is how a date
 * somebody is hoping for gets quoted to a customer as a date that happened.
 *
 * Server component. No state.
 */

function dayMonth(iso: string): string {
  const [y, m, d] = iso.split('-')
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  return `${Number(d)} ${months[Number(m) - 1] ?? m} ${y.slice(2)}`
}

export default function CargoEventList({ events, today }: { events: CargoEventRow[]; today: string }) {
  if (!events.length) return <p className="text-sm text-gray-500">Nothing has been reported yet.</p>

  // One line per milestone. Cargo Partner raises a container event once per
  // container AND again as a roll-up with no container number on it, so a
  // shipment that loaded once shows "Loaded on vessel" twice. They are not
  // duplicate rows, they differ by that field, so the sync keeps both for the
  // lead-time record; a person reading a history wants the milestone once.
  const collapsed: (CargoEventRow & { containers: string[] })[] = []
  const at = new Map<string, number>()
  for (const e of events) {
    const key = [e.identifier, e.date, e.time, e.locationCode ?? '', e.locationName ?? ''].join('\u0000')
    const seen = at.get(key)
    if (seen === undefined) {
      at.set(key, collapsed.length)
      collapsed.push({ ...e, containers: e.containerNumber ? [e.containerNumber] : [] })
    } else if (e.containerNumber && !collapsed[seen].containers.includes(e.containerNumber)) {
      collapsed[seen].containers.push(e.containerNumber)
    }
  }

  const newestFirst = [...collapsed].reverse()

  return (
    <ol className="space-y-0">
      {newestFirst.map((e, i) => {
        const future = e.date > today
        const dot =
          e.kind === 'exception' ? 'bg-amber-500' : e.kind === 'estimate' ? 'bg-gray-300' : 'bg-[#025945]'
        return (
          <li key={`${e.identifier}-${e.date}-${e.time}-${i}`} className="flex gap-3 py-2">
            <div className="flex flex-col items-center pt-1.5">
              <span className={`h-2 w-2 shrink-0 rounded-full ${dot}`} aria-hidden="true" />
              {i < newestFirst.length - 1 && <span className="mt-1 w-px flex-1 bg-gray-200" aria-hidden="true" />}
            </div>
            <div className="min-w-0 flex-1 pb-1">
              <p className={`text-sm ${e.kind === 'actual' ? 'font-medium text-gray-900' : 'text-gray-500'}`}>
                {e.name}
                {e.locationName ? <span className="font-normal text-gray-500"> at {e.locationName}</span> : ''}
              </p>
              <p className="text-xs tabular-nums text-gray-400">
                {dayMonth(e.date)}
                {e.time ? ` ${e.time.slice(0, 5)}` : ''}
                {future ? ' · forecast' : ''}
                {e.containers.length > 1 ? ` · ${e.containers.join(', ')}` : ''}
              </p>
              {e.kind === 'exception' && e.delaySeconds != null && (
                <p className="mt-0.5 text-xs text-amber-700">
                  {e.delaySeconds > 0
                    ? `Pushed back by ${(e.delaySeconds / 86400).toFixed(1)} days`
                    : `Pulled forward by ${Math.abs(e.delaySeconds / 86400).toFixed(1)} days`}
                </p>
              )}
            </div>
          </li>
        )
      })}
    </ol>
  )
}
