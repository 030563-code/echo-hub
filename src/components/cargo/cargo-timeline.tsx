import { Fragment } from 'react'
import { Ship, Train, Truck, Plane, Check, Anchor, Warehouse, MapPin, Home } from 'lucide-react'
import type { TimelineStop } from '@/lib/cargo/payload'

/**
 * Where a container is, drawn from the route the forwarder returned.
 *
 * Dean, 22 Sep 2026: "All the details should be from the API ... these can be
 * different sometimes so the timeline representation should be dynamic to what
 * the API returns."
 *
 * So there is no template here. Four stops, six stops, a transhipment in the
 * middle, a rail leg into Hamilton: the component draws what it is handed. The
 * shape of the real data on that day ran from two stops to six across 25
 * shipments, so a fixed pickup / load / discharge / deliver picture would have
 * been wrong on the first one that transhipped.
 *
 * A stop is green once it has ACTUALLY happened. An estimate is drawn hollow
 * with its date underneath, because a date you are hoping for and a date that
 * happened should never look the same on a page somebody is acting on.
 *
 * Server component. No state, so nothing to keep in user_page_state.
 */

const LEG_ICONS = {
  sea: Ship,
  rail: Train,
  road: Truck,
  air: Plane,
} as const

const STOP_ICONS: Record<string, typeof Anchor> = {
  PICKUP: Warehouse,
  PORT_OF_LOADING: Anchor,
  TRANSIT_HUB: MapPin,
  PORT_OF_DISCHARGE: Anchor,
  DELIVERY: Home,
}

/** "2026-09-27" → "27 Sep". The year only when it is not this one. */
function shortDate(iso: string | null, today: string): string | null {
  if (!iso) return null
  const [y, m, d] = iso.split('-')
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  const month = months[Number(m) - 1] ?? m
  return y === today.slice(0, 4) ? `${Number(d)} ${month}` : `${Number(d)} ${month} ${y}`
}

function Leg({ mode }: { mode: TimelineStop['legToNext'] }) {
  const Icon = mode ? LEG_ICONS[mode] : null
  return (
    // A list item, not a div: an <ol> may only contain <li>, and a stop is one.
    <li className="flex min-w-10 flex-1 shrink-0 items-center pt-[26px] sm:min-w-14" aria-hidden="true">
      <span className="h-px flex-1 bg-gray-300" />
      {Icon && (
        <span className="mx-1.5 text-gray-400">
          <Icon className="h-4 w-4" strokeWidth={1.75} />
        </span>
      )}
      <span className="h-px flex-1 bg-gray-300" />
    </li>
  )
}

function Stop({ stop, today }: { stop: TimelineStop; today: string }) {
  const Icon = STOP_ICONS[stop.type] ?? MapPin
  const done = stop.state === 'done'
  const current = stop.state === 'current'

  const ring = done
    ? 'bg-[#025945] text-white ring-[#025945]'
    : current
      ? 'bg-white text-[#025945] ring-[#025945] ring-[3px]'
      : 'bg-white text-gray-400 ring-gray-300'

  return (
    <li className="flex w-24 shrink-0 flex-col items-center text-center sm:w-28">
      <p className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-gray-400">{stop.label}</p>
      <span className={`flex h-9 w-9 items-center justify-center rounded-full ring-2 ${ring}`}>
        {done ? <Check className="h-4 w-4" strokeWidth={2.5} /> : <Icon className="h-4 w-4" strokeWidth={2} />}
      </span>
      <p className={`mt-2 text-sm font-medium ${current ? 'text-[#025945]' : 'text-gray-900'}`}>
        {stop.place ?? stop.code ?? '—'}
      </p>
      {stop.code && stop.place !== stop.code && (
        <p className="text-[11px] tabular-nums text-gray-400">{stop.code}</p>
      )}
      {stop.date ? (
        <p className={`mt-1 text-xs tabular-nums ${stop.actual ? 'text-gray-700' : 'text-gray-400'}`}>
          {shortDate(stop.date, today)}
        </p>
      ) : (
        <p className="mt-1 text-xs text-gray-300">—</p>
      )}
      {stop.caption && (
        <p className={`text-[11px] ${stop.actual ? 'text-[#025945]' : 'text-gray-400'}`}>{stop.caption}</p>
      )}
    </li>
  )
}

export default function CargoTimeline({
  stops,
  today,
  className = '',
}: {
  stops: TimelineStop[]
  today: string
  className?: string
}) {
  if (!stops.length) {
    return (
      <p className={`text-sm text-gray-500 ${className}`}>
        The forwarder has not published a route for this shipment yet.
      </p>
    )
  }

  return (
    // A six stop route does not fit a phone, so the row scrolls sideways inside
    // its own container and the page never does. Same pattern the invoicing nav
    // already uses.
    <div className={`-mx-4 overflow-x-auto px-4 pb-1 ${className}`}>
      <ol className="flex min-w-max items-start justify-between gap-0">
        {stops.map((stop, i) => (
          <Fragment key={`${stop.type}-${stop.code ?? stop.place ?? i}`}>
            <Stop stop={stop} today={today} />
            {i < stops.length - 1 && <Leg mode={stop.legToNext} />}
          </Fragment>
        ))}
      </ol>
    </div>
  )
}
